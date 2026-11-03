import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

/**
 * SECURITY DEFINER functions that read outside the caller's tenant context by design (0130,
 * 0131). Each must run with `row_security = off`, so that an owner without BYPASSRLS errors
 * instead of seeing zero rows and answering "nothing there".
 *
 * **Adding a definer function?** Put it in exactly one list. If it reads rows of another tenant,
 * or runs before a tenant is set (sign-in, token lookups, purges, gauges), it goes in
 * `CROSS_TENANT` and its migration sets `row_security = off`.
 */
const CROSS_TENANT = [
  "core.find_person_by_email(text)",
  "core.start_email_challenge(core.email_challenge_purpose,text,text,uuid,bytea,text,text,text)",
  "core.verify_sign_in_code(text,bytea,text,text,uuid,text,integer)",
  "core.create_invitation(uuid,uuid,text,uuid,text,text)",
  "core.accept_invitation(text,bytea,text,uuid,text,uuid,text,integer)",
  "core.request_email_change(uuid,uuid,text,text,uuid)",
  "core.decide_email_change(uuid,uuid,boolean,text,integer,uuid,bytea,text)",
  "core.complete_email_change(text,bytea,text,text)",
  "core.purge_email_auth_records()",
  "core.open_bootstrap_enrolment_window(uuid)",
  "core.start_oidc_transaction(uuid,core.oidc_provider,core.oidc_purpose,text,text,text,bytea,text,uuid,text,text,text)",
  "core.claim_oidc_transaction(text,text,core.oidc_provider,uuid)",
  "core.complete_oidc_sign_in(uuid,text,text,uuid,text,integer)",
  "core.complete_oidc_link(uuid,uuid,text,text,text,text,uuid)",
  "core.complete_oidc_invitation(uuid,text,text,text,text,text,uuid,uuid,uuid,text,integer)",
  "core.purge_oidc_records()",
  "core.purge_auth_records()",
  "core.resolve_session(text)",
  "core.sessions_refuse_suspended()",
  "core.decide_subject_suspension(uuid,uuid,boolean,text,integer)",
  "core.operational_gauges()",
  "core.governance_votes_pin_weight()",
  "core.bind_wallet_by_proof(uuid,uuid,text,uuid,text)",
  // Session and service-token paths, before 0112 (0005/0026/0074, 0108, 0109): read before a
  // tenant is set.
  "core.revoke_session(text)",
  "core.resolve_service_token(text)",
  "core.resolve_role_bindings(uuid)",
];

/** Audited (0112–0130): act inside the tenant context the caller set — see 0131's header. */
const SAME_TENANT = [
  "core.create_subject_session(uuid,text,uuid,core.session_first_factor,core.session_second_factor,integer)",
  "core.revoke_subject_sessions(uuid,text)",
  "core.session_email_challenge_consumed()",
  "core.revoke_invitation(uuid,uuid,integer)",
  "core.mfa_status(uuid)",
  "core.create_webauthn_challenge(uuid,core.webauthn_challenge_purpose,text)",
  "core.live_webauthn_challenge(uuid,core.webauthn_challenge_purpose)",
  "core.complete_webauthn_registration(uuid,text,text,bytea,bigint,text[],uuid,boolean,text,boolean,text,text[])",
  "core.complete_webauthn_authentication(uuid,text,text,bigint,boolean)",
  "core.rename_webauthn_credential(uuid,uuid,text)",
  "core.begin_totp_enrolment(uuid,uuid,bytea,bytea)",
  "core.reserve_totp_attempt(uuid,boolean)",
  "core.complete_totp(uuid,uuid,bigint,text[])",
  "core.consume_recovery_code(uuid,text)",
  "core.regenerate_recovery_codes(uuid,text[])",
  "core.remove_authenticator(uuid,text,uuid)",
  "core.mfa_reset_separation_guard()",
  "core.external_identity_person_only()",
  "core.session_oidc_transaction_completed()",
  "core.list_external_identities(uuid)",
  "core.unlink_external_identity(uuid,uuid)",
  "core.disable_own_wallet(uuid,uuid,text,text)",
  "core.revoke_subject_identities(uuid,uuid,text)",
  "core.subject_sign_in_providers(uuid[])",
  "core.list_own_sessions(uuid)",
  "core.revoke_own_session(uuid,uuid)",
  "core.subject_suspension_proposal_guard()",
  "core.refuse_suspended_actor()",
  "core.decide_mfa_reset(uuid,uuid,boolean,text,integer)",
  "core.create_wallet_binding_challenge(uuid,uuid,text,integer,text)",
  "core.live_wallet_binding_challenge(uuid,uuid)",
];

/**
 * Created before 0112, off the session and service-token paths, and not part of the 0131 audit:
 * public read models, the ledger, sweeps and the worker heartbeat.
 */
const BEFORE_0112 = [
  "core.public_registry_versions(text,text)",
  "core.public_batch_leaves(uuid)",
  "core.public_protocol_proposal_transitions(uuid)",
  "core.seconds_since_worker_heartbeat(text)",
  "core.public_registry_list(text,text,text,integer,timestamp with time zone,uuid)",
  "core.public_disclosure_events(integer,timestamp with time zone,uuid)",
  "core.sweep_document_expiry(date)",
  "core.sweep_credential_expiry(timestamp with time zone)",
  "core.public_protocol_proposals(integer,timestamp with time zone,uuid)",
  "core.public_governance_role_holders()",
  "core.public_anchor_authority()",
  "core.public_evidence_ledger_current(uuid)",
  "core.lock_ledger_publication_inputs()",
  "core.guard_ledger_input_write()",
  "core.public_evidence_ledger_current(uuid,timestamp with time zone)",
  "core.public_inclusion_proof(uuid)",
  "core.public_hash_lookup(text)",
];

describeDb("cross-tenant SECURITY DEFINER functions (0131)", () => {
  const dbName = `m0131_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let definers: { signature: string; config: string[] | null }[];

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });
    await runMigrations(sql, listMigrations());
    definers = await sql<{ signature: string; config: string[] | null }[]>`
      SELECT p.oid::regprocedure::text AS signature, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'core' AND p.prosecdef
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("every cross-tenant definer runs with row_security = off", () => {
    const bySignature = new Map(definers.map((d) => [d.signature, d.config ?? []]));
    for (const signature of CROSS_TENANT) {
      expect(bySignature.has(signature), `${signature} exists`).toBe(true);
      expect(bySignature.get(signature), signature).toContain("row_security=off");
    }
  });

  it("every definer function is classified, in exactly one list", () => {
    const lists = [...CROSS_TENANT, ...SAME_TENANT, ...BEFORE_0112];
    expect(new Set(lists).size).toBe(lists.length);
    const unclassified = definers.map((d) => d.signature).filter((s) => !lists.includes(s));
    expect(unclassified, "add each to CROSS_TENANT or SAME_TENANT (see the comment above)").toEqual([]);
    const gone = lists.filter((s) => !definers.some((d) => d.signature === s));
    expect(gone, "listed but no longer a definer: update the list").toEqual([]);
  });

  /**
   * The proconfig check above says the setting is there; this says it does what 0131 claims.
   * Under an owner without BYPASSRLS, each pre-tenant lookup must raise instead of answering
   * "nothing there". Under the bypassing owner the same calls succeed (and find nothing).
   */
  it("under an owner without BYPASSRLS the pre-tenant lookups fail loudly, not empty", async () => {
    const calls: { fn: string; call: string; arg: string }[] = [
      { fn: "core.find_person_by_email(text)", call: "core.find_person_by_email($1)", arg: "nobody@example.test" },
      { fn: "core.resolve_session(text)", call: "core.resolve_session($1)", arg: "0".repeat(64) },
      { fn: "core.revoke_session(text)", call: "core.revoke_session($1)", arg: "0".repeat(64) },
      { fn: "core.resolve_service_token(text)", call: "core.resolve_service_token($1)", arg: "0".repeat(64) },
      {
        fn: "core.resolve_role_bindings(uuid)",
        call: "core.resolve_role_bindings($1::uuid)",
        arg: "00000000-0000-4000-8000-000000000000",
      },
    ];
    const role = `m0131_nobypass_${process.pid}`;
    const rollback = new Error("rollback");
    const outcomes: Record<string, string> = {};

    await expect(
      sql.begin(async (tx) => {
        for (const { fn, call, arg } of calls) {
          await tx.savepoint(async (sp) => {
            await sp.unsafe(`SELECT * FROM ${call}`, [arg]);
          });
          outcomes[`${fn} (bypassing owner)`] = "ok";
        }

        const [row] = await tx<{ owner: string }[]>`
          SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
          WHERE oid = 'core.find_person_by_email(text)'::regprocedure
        `;
        await tx`CREATE ROLE ${tx(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${tx(row!.owner)}`;

        for (const { fn, call, arg } of calls) {
          await tx.unsafe(`ALTER FUNCTION ${fn} OWNER TO "${role}"`);
          try {
            await tx.savepoint(async (sp) => {
              await sp.unsafe(`SELECT * FROM ${call}`, [arg]);
            });
            outcomes[fn] = "answered";
          } catch (error) {
            outcomes[fn] = (error as Error).message;
          }
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    for (const { fn } of calls) {
      expect(outcomes[`${fn} (bypassing owner)`], fn).toBe("ok");
      expect(outcomes[fn], fn).toMatch(/row-level security/);
    }
  });

  /**
   * 0132 (F5): the two same-tenant guards that used to answer "not suspended" when they read no
   * row now refuse. A reset request is inserted with no tenant set, so an owner filtered by RLS
   * reads nothing; under the bypassing owner the same insert passes.
   */
  it("the actor and reset guards refuse when an owner without BYPASSRLS reads nothing", async () => {
    const tenant = crypto.randomUUID();
    const [target, proposer] = [crypto.randomUUID(), crypto.randomUUID()];
    const role = `m0132_nobypass_${process.pid}`;
    const rollback = new Error("rollback");
    const outcomes: Record<string, string> = {};
    const insertReset = (tx: postgres.TransactionSql) =>
      tx.savepoint((sp) => sp`
        INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id)
        VALUES (${crypto.randomUUID()}, ${tenant}, ${target}, 'lost', ${proposer})
      `).then(() => "ok", (error: Error) => error.message);

    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0132-${tenant.slice(0, 8)}`}, 'Probe')`;
        for (const id of [target, proposer]) {
          await tx`
            INSERT INTO core.subjects (id, tenant_id, kind, display_name, created_at)
            VALUES (${id}, ${tenant}, 'person', 'Probe', now() - interval '10 days')
          `;
        }
        outcomes["bypassing owner"] = await insertReset(tx);

        const [row] = await tx<{ owner: string }[]>`
          SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
          WHERE oid = 'core.refuse_suspended_actor()'::regprocedure
        `;
        await tx`CREATE ROLE ${tx(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${tx(row!.owner)}`;

        await tx.unsafe(`ALTER FUNCTION core.mfa_reset_separation_guard() OWNER TO "${role}"`);
        outcomes["mfa_reset_separation_guard"] = await insertReset(tx);
        await tx.unsafe(`ALTER FUNCTION core.mfa_reset_separation_guard() OWNER TO "${row!.owner}"`);

        await tx.unsafe(`ALTER FUNCTION core.refuse_suspended_actor() OWNER TO "${role}"`);
        outcomes["refuse_suspended_actor"] = await insertReset(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(outcomes).toEqual({
      "bypassing owner": "ok",
      mfa_reset_separation_guard: expect.stringMatching(/^MFA_RESET_SUBJECT_UNREADABLE/),
      refuse_suspended_actor: expect.stringMatching(/^ACTOR_UNREADABLE/),
    });
  });
});
