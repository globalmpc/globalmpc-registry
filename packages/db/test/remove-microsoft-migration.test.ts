import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrations, runMigrations } from "../src/migrate.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

const TID = "11111111-1111-4111-8111-111111111111";
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/**
 * 0171 on a database that has Microsoft rows.
 *
 * Expected, from the decision table in the migration: every Microsoft session, login transaction
 * and identity is gone, live or revoked, and Google rows are untouched; a pending notice names only
 * Google; the provider types no longer hold `microsoft` and `idp_tenant` is gone. A wallet
 * recovery opened from a Microsoft session stops the migration before anything changes.
 */
describeDb("0171: Microsoft sign-in removal on a populated database", () => {
  const database = `m0171_${process.pid}_${Date.now()}`;
  const person = randomUUID(), other = randomUUID();
  const msIdentity = randomUUID(), msRevoked = randomUUID(), googleIdentity = randomUUID();
  const msTransaction = randomUUID(), googleTransaction = randomUUID();
  const msSession = randomUUID(), googleSession = randomUUID();
  const notice = randomUUID(), settledNotice = randomUUID(), recovery = randomUUID();
  let admin: postgres.Sql, sql: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(url!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const isolated = new URL(url!);
    isolated.pathname = database;
    sql = postgres(isolated.toString(), { onnotice: () => {}, max: 1 });
    await runMigrations(sql, listMigrations().filter((migration) => migration.name < "0171"));

    await sql`INSERT INTO core.subjects (id, kind, display_name, email) VALUES
      (${person}, 'person', 'Microsoft person', ${`ms-${person}@example.test`}),
      (${other}, 'person', 'Google person', ${`g-${other}@example.test`})`;
    // Sessions name a transaction completed in the same database transaction (0120); these rows
    // stand for ones a real flow wrote, so the row triggers are skipped while they go in.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO core.external_identities (id, subject_id, provider, issuer, subject_key, idp_tenant, linked_via, revoked_at, revoked_reason) VALUES
        (${msIdentity}, ${person}, 'microsoft', ${`https://login.microsoftonline.com/${TID}/v2.0`}, ${randomUUID()}, ${TID}, 'link', NULL, NULL),
        (${msRevoked}, ${person}, 'microsoft', ${`https://login.microsoftonline.com/${TID}/v2.0`}, ${randomUUID()}, ${TID}, 'link', now(), 'unlinked_by_holder'),
        (${googleIdentity}, ${other}, 'google', 'https://accounts.google.com', ${`g-${other}`}, NULL, 'link', NULL, NULL)`;
      for (const [id, provider, identity, subject] of [
        [msTransaction, "microsoft", msIdentity, person],
        [googleTransaction, "google", googleIdentity, other],
      ] as const) {
        await tx`INSERT INTO core.oidc_login_transactions (id, provider, purpose, state_hash, binding_hash, nonce_hash, redirect_uri, subject_id, identity_id, created_at, expires_at, claimed_at, completed_at, completed_txid, outcome)
          VALUES (${id}, ${provider}, 'sign_in', ${hex(32)}, ${hex(32)}, ${hex(32)}, ${`https://registry.example/auth/oidc/${provider}/callback`}, ${subject}, ${identity}, now(), now() + interval '10 minutes', now(), now(), pg_current_xact_id(), 'session')`;
      }
      for (const [id, subject, factor, transaction] of [
        [msSession, person, "microsoft", msTransaction],
        [googleSession, other, "google", googleTransaction],
      ] as const) {
        await tx`INSERT INTO core.sessions (id, token_hash, subject_id, first_factor, oidc_transaction_id, expires_at)
          VALUES (${id}, ${`0x${hex(32)}`}, ${subject}, ${factor}, ${transaction}, now() + interval '1 hour')`;
      }
    });
    await sql`INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at) VALUES
      (${notice}, 'email_changed_notice', ${`ms-${person}@example.test`}, ${sql.json({ removedSignIns: ["google", "microsoft"] })}, 'pending', now() + interval '1 day')`;
    await sql`INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at, settled_at) VALUES
      (${settledNotice}, 'email_changed_notice', NULL, NULL, 'sent', now() + interval '1 day', now())`;
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("stops before changing anything while a wallet recovery stands on a Microsoft session", async () => {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO core.wallet_recoveries (id, subject_id, session_id, previous_wallet_id, previous_version, chain_id, wallet_address, email, proof_digest)
        VALUES (${recovery}, ${person}, ${msSession}, ${randomUUID()}, 1, 31337, ${`0x${hex(20)}`}, ${`ms-${person}@example.test`}, ${randomBytes(32)})`;
    });
    await expect(runMigrations(sql, listMigrations())).rejects.toThrow(/wallet recovery was opened from a Microsoft session/);
    expect(await sql`SELECT name FROM core.schema_migrations WHERE name >= '0171'`).toHaveLength(0);
    expect(await sql`SELECT id FROM core.sessions WHERE id = ${msSession}`).toHaveLength(1);
    await sql`DELETE FROM core.wallet_recoveries WHERE id = ${recovery}`;
  }, 120_000);

  it("deletes every Microsoft row, keeps Google's, and leaves no Microsoft in the schema", async () => {
    await runMigrations(sql, listMigrations());

    expect(await sql`SELECT id FROM core.sessions WHERE id IN (${msSession}, ${googleSession})`).toEqual([{ id: googleSession }]);
    expect(await sql`SELECT id FROM core.oidc_login_transactions WHERE id IN (${msTransaction}, ${googleTransaction})`)
      .toEqual([{ id: googleTransaction }]);
    expect(await sql`SELECT id FROM core.external_identities WHERE subject_id IN (${person}, ${other})`)
      .toEqual([{ id: googleIdentity }]);
    expect(await sql`SELECT id FROM core.subjects WHERE id = ${person}`).toHaveLength(1);

    const [pending] = await sql<{ params: unknown }[]>`SELECT params FROM core.email_outbox WHERE id = ${notice}`;
    expect(pending!.params).toEqual({ removedSignIns: ["google"] });
    expect(await sql`SELECT state FROM core.email_outbox WHERE id = ${settledNotice}`).toEqual([{ state: "sent" }]);

    const [types] = await sql<{ provider: string; factor: string }[]>`
      SELECT enum_range(NULL::core.oidc_provider)::text AS provider, enum_range(NULL::core.session_first_factor)::text AS factor`;
    expect(types).toEqual({ provider: "{google}", factor: "{email_code,google,siwe_legacy}" });
    expect(await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'core' AND column_name = 'idp_tenant'`).toHaveLength(0);
    expect(await sql`
      SELECT p.oid::regprocedure AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('core', 'chain', 'audit') AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ~* 'microsoft|idp_tenant'`).toHaveLength(0);
    expect(await sql`SELECT conname FROM pg_constraint WHERE pg_get_constraintdef(oid) ~* 'microsoft|idp_tenant'`).toHaveLength(0);
  }, 120_000);

  it("refuses a Microsoft identity or session from now on, even from the owner", async () => {
    await expect(sql`INSERT INTO core.external_identities (id, subject_id, provider, issuer, subject_key, linked_via)
      VALUES (${randomUUID()}, ${person}, 'microsoft', ${`https://login.microsoftonline.com/${TID}/v2.0`}, ${randomUUID()}, 'link')`)
      .rejects.toThrow(/invalid input value for enum/);
    await expect(sql`INSERT INTO core.external_identities (id, subject_id, provider, issuer, subject_key, linked_via)
      VALUES (${randomUUID()}, ${person}, 'google', ${`https://login.microsoftonline.com/${TID}/v2.0`}, ${randomUUID()}, 'link')`)
      .rejects.toThrow(/external_identities_issuer/);
    await expect(sql`SELECT 'microsoft'::core.session_first_factor`).rejects.toThrow(/invalid input value for enum/);
  });

  it("keeps the API role's grants on the recreated functions", async () => {
    const rows = await sql<{ f: string; app: boolean; public: boolean }[]>`
      SELECT p.oid::regprocedure::text AS f,
             has_function_privilege('mpc_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public
      FROM pg_proc p WHERE p.oid = ANY (ARRAY[
        'core.complete_oidc_invitation(uuid,text,text,text,text,uuid,uuid,uuid,text,integer)'::regprocedure,
        'core.complete_oidc_link(uuid,uuid,text,text,text,uuid,text)'::regprocedure,
        'core.list_external_identities(uuid)'::regprocedure,
        'core.resolve_session(text)'::regprocedure,
        'core.insert_oidc_session(uuid,core.oidc_provider,uuid,uuid,text,integer)'::regprocedure,
        'core.create_subject_session(uuid,text,uuid,core.session_first_factor,core.session_second_factor,integer)'::regprocedure
      ]) ORDER BY 1`;
    expect(Object.fromEntries(rows.map((row) => [row.f.replace(/\(.*/, ""), [row.app, row.public]]))).toEqual({
      "core.complete_oidc_invitation": [true, false],
      "core.complete_oidc_link": [true, false],
      "core.list_external_identities": [true, false],
      "core.resolve_session": [true, false],
      "core.insert_oidc_session": [false, false],
      "core.create_subject_session": [false, false],
    });
    expect(await sql`SELECT to_regprocedure('core.complete_oidc_link(uuid,uuid,text,text,text,text,uuid)') AS old`)
      .toEqual([{ old: null }]);
  });
});
