import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { runMigrations, withTenant } from "@mpc/db";
import {
  hashToken,
  newSessionToken,
  SESSION_TTL_SECONDS,
} from "../../src/plugins/session-token.js";
import { issueServiceToken } from "../../src/service-tokens.js";

/**
 * Test DB helpers.
 *
 * Unlike the `packages/db` helpers, these do not drop the schema. Tests at this layer verify
 * behavior on top of the schema, not its lifecycle, so **each file isolates itself with its
 * own tenant**. Dropping would break other tests sharing the same instance.
 */
export interface TestFixture {
  /** Superuser connection. Used for seeding. */
  readonly sql: postgres.Sql;
  /** Application role connection. RLS applies. */
  readonly appSql: postgres.Sql;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly orgA: string;
  readonly orgB: string;
  /** tenant A · mpc_operator · high_assurance */
  readonly operatorA: TestAccount;
  /** tenant B · mpc_operator · high_assurance */
  readonly operatorB: TestAccount;
  /** tenant A · no role · wallet_only */
  readonly readerA: TestAccount;
  /** A key bound to no subject. `signIn` refuses it: a wallet alone signs nobody in (WP7). */
  readonly unknownWallet: TestAccount;
  /** tenant A · reviewer_cp_qp · high_assurance */
  readonly reviewerA: TestAccount;
  /** tenant A · gate_approver · high_assurance */
  readonly approverA: TestAccount;
  /** tenant A · data_steward · identity_bound. handles evidence and claims (02 §2.3) */
  readonly stewardA: TestAccount;
  /**
   * tenant A · data_steward · **binding scoped to projectA only**.
   *
   * Both are needed to test organization-level versus project-level bindings.
   * This account is a steward in `projectA` but nothing in `otherProjectA`.
   */
  readonly scopedStewardA: TestAccount;
  /**
   * tenant A · scan_service, a **service** subject. Holds no wallet and cannot `signIn`; it
   * authenticates with `scanServiceToken` (D7).
   */
  readonly scanServiceA: TestAccount;
  /** Service token of the scan service, scoped to `scan_result`. */
  readonly scanServiceToken: string;
  readonly scanServiceSubjectA: string;
  /** tenant A · protocol_proposer. Creates governance proposals */
  readonly proposerA: TestAccount;
  /** tenant A · protocol_voter. Only votes */
  readonly voterA: TestAccount;
  /** tenant A · auditor. Decides authority approval (02 §2.8) */
  readonly auditorA: TestAccount;
  /** tenant A · disclosure_approver. Publishes what an operator drafted (02 §2.8) */
  readonly disclosureApproverA: TestAccount;
  /** operatorA's subject id. Used to check whether registrant and approver are the same */
  readonly operatorSubjectA: string;
  /** Pre-created project in tenant A */
  readonly projectA: string;
  /** Another project in the same tenant. Tests access outside project scope */
  readonly otherProjectA: string;
  /** Accepted authority of tenant A */
  readonly authorityA: string;
  /** Active source connection of tenant A */
  readonly connectionA: string;
  /** Active attestation schema of tenant A */
  readonly schemaA: string;
  /** Valid credential of reviewerA, issued by `issuerAuthorityA` */
  readonly credentialA: string;
  /**
   * Accepted authority that issued `credentialA`, recognized for the fixture claim types.
   * AC-15·AC-16 judge a credential by its issuer, so the fixture credential needs one.
   */
  readonly issuerAuthorityA: string;
  /**
   * reviewerA's organization. Not `orgA`, which owns the fixture projects — a reviewer from the
   * operating organization is not independent (02 §2.4 rule 2).
   */
  readonly reviewOrgA: string;
  /** Subject id of reviewerA */
  readonly reviewerSubjectA: string;
  /** Subject id of stewardA — the submitter of claims the steward creates (02 §2.4 rule 1) */
  readonly stewardSubjectA: string;
  close(): Promise<void>;
}

/**
 * A fixture person's signing key. The address finds the person (`signIn`), and the key signs
 * attestations and gate decisions as one of the person's bound wallets.
 */
export interface TestAccount {
  readonly address: `0x${string}`;
  readonly account: ReturnType<typeof privateKeyToAccount>;
}

export function newAccount(): TestAccount {
  const account = privateKeyToAccount(generatePrivateKey());
  return { address: account.address.toLowerCase() as `0x${string}`, account };
}

/**
 * Signs in as the fixture person who holds `account`'s key, and returns a session token.
 *
 * Wallet sign-in is gone (D3, WP7), so the key only **finds** the person: the subject holding an
 * active wallet with this address. The session is then a real account session through
 * `issueTestSession` — an emailed code (first factor) raised with a passkey. A passkey because it
 * is the only factor that reaches `aal3`, the level every high-assurance role needs
 * (`requiredAuthenticationLevel`): reviewers, approvers, operators. With it every fixture role is
 * effective, as it was with the SIWE session this replaces, which counted as `aal3`. Tests of
 * what a lower level may do issue the session themselves (`issueTestSession`).
 *
 * `app` is unused and kept so the signature matches the old helper's call sites.
 */
export async function signIn(_app: FastifyInstance, account: TestAccount): Promise<string> {
  const [holder] = await seedConnection()<{ subject_id: string; tenant_id: string }[]>`
    SELECT w.subject_id, w.tenant_id
    FROM core.wallet_identities w
    JOIN core.subjects s ON s.id = w.subject_id AND s.kind = 'person'
    WHERE w.wallet_address = ${account.address} AND w.disabled_at IS NULL
    ORDER BY w.created_at
    LIMIT 1
  `;
  if (!holder) {
    throw new Error(
      `signIn: ${account.address} is not an active wallet of any person — a key bound to nobody signs nobody in`,
    );
  }
  return issueTestSession(appConnection(), holder.tenant_id, holder.subject_id, {
    firstFactor: "email_code",
    secondFactor: "passkey",
  });
}

/** Migration-role connection the session helper seeds with. Opened on first use. */
let seedSql: postgres.Sql | null = null;
function seedConnection(): postgres.Sql {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");
  seedSql ??= postgres(url, { onnotice: () => {}, max: 1, idle_timeout: 2 });
  return seedSql;
}

/**
 * Application-role connection `signIn` issues sessions over — the role the API itself uses, as
 * `issueTestSession` expects. `setupFixture` creates the login role first. Opened on first use.
 */
let appSqlShared: postgres.Sql | null = null;
function appConnection(): postgres.Sql {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");
  const appUrl = new URL(url);
  appUrl.username = "mpc_app_login";
  appUrl.password = "app";
  appSqlShared ??= postgres(appUrl.toString(), { onnotice: () => {}, max: 2, idle_timeout: 2 });
  return appSqlShared;
}

/**
 * Issues a session for a subject through the real database path a login flow uses. Use it to
 * test what a session at a given AAL may do.
 *
 * - `google` / `microsoft`: the login-transaction path itself (0121). Such a session exists only
 *   when a transaction was completed for its subject in the same transaction, so the helper links
 *   a fixture identity to the subject if it has none of that provider (over the migration
 *   connection), then starts, claims and completes a sign-in transaction through the functions
 *   the API calls. Only the ID-token check is skipped — the database never sees the token; the
 *   OIDC route tests (`oidc.test.ts`) run the whole flow against an in-process provider.
 * - `email_code`: the emailed-code path itself (0114). An `email_code` session exists only when a
 *   challenge was consumed in the same transaction, so the helper gives the subject an address
 *   if it has none (`session-<subject>@example.test`, over the migration connection — the
 *   application role cannot write it), asks for a code with an HMAC it chose (the database never
 *   sees the API's key, so any 32 bytes do) and checks it. The mail that start queued is deleted.
 *
 * With `secondFactor`, the session is then raised by `test_support.elevate_session`, which writes
 * the evidence a real ceremony leaves (a consumed challenge for a fixture passkey, a spent step of
 * a fixture TOTP, a consumed recovery code) and points the session at it — the same rows the
 * database requires of every second factor (0116). That function exists only in databases
 * `setupFixture` prepared; no migration creates it. Tests of the ceremonies themselves go through
 * the MFA routes (`mfa.test.ts`).
 *
 * `sql` should be the application connection (`fx.appSql`): the functions are what the API calls.
 */
export async function issueTestSession(
  sql: postgres.Sql,
  tenantId: string,
  subjectId: string,
  factors: {
    readonly firstFactor: "email_code" | "google" | "microsoft";
    readonly secondFactor?: "passkey" | "totp" | "recovery_code" | null;
  },
): Promise<string> {
  const firstFactor = factors.firstFactor;
  if (firstFactor !== "email_code") {
    const issued = await oidcTestSession(sql, tenantId, subjectId, firstFactor);
    if (factors.secondFactor) await elevate(sql, tenantId, issued.sessionId, factors.secondFactor);
    return issued.token;
  }

  const seed = seedConnection();
  const [subject] = await seed<{ email: string }[]>`
    UPDATE core.subjects SET email = COALESCE(email, ${`session-${subjectId}@example.test`})
    WHERE id = ${subjectId} AND tenant_id = ${tenantId} AND kind = 'person'
    RETURNING email
  `;
  if (!subject) throw new Error(`no person subject ${subjectId} in tenant ${tenantId}`);

  const hmac = randomBytes(32);
  const challengeId = randomUUID();
  const [started] = await sql<{ status: string }[]>`
    SELECT status FROM core.start_email_challenge(
      'sign_in', ${subject.email}, NULL, ${challengeId}, ${hmac}, '12345678',
      ${randomUUID()}, ${randomUUID()}
    )
  `;
  if (started?.status !== "issued") throw new Error(`code not issued: ${started?.status}`);
  await seed`DELETE FROM core.email_outbox WHERE challenge_id = ${challengeId}`;

  const token = newSessionToken();
  const sessionId = randomUUID();
  const [verified] = await sql<{ status: string }[]>`
    SELECT status FROM core.verify_sign_in_code(
      ${subject.email}, ${hmac}, ${randomUUID()}, ${randomUUID()}, ${sessionId}, ${hashToken(token)},
      ${SESSION_TTL_SECONDS}
    )
  `;
  if (verified?.status !== "session_created") throw new Error(`no session: ${verified?.status}`);

  if (factors.secondFactor) await elevate(sql, tenantId, sessionId, factors.secondFactor);
  return token;
}

/** The Microsoft directory fixture identities live in. */
export const FIXTURE_MICROSOFT_TENANT = "0f0f0f0f-0000-4000-8000-000000000001";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** A sign-in session for `subjectId` through 0121's functions; see `issueTestSession`. */
async function oidcTestSession(
  sql: postgres.Sql,
  tenantId: string,
  subjectId: string,
  provider: "google" | "microsoft",
): Promise<{ token: string; sessionId: string }> {
  const seed = seedConnection();
  const [person] = await seed`
    SELECT 1 FROM core.subjects WHERE id = ${subjectId} AND tenant_id = ${tenantId} AND kind = 'person'
  `;
  if (!person) throw new Error(`no person subject ${subjectId} in tenant ${tenantId}`);
  const [existing] = await seed<{ issuer: string; subject_key: string }[]>`
    SELECT issuer, subject_key FROM core.external_identities
    WHERE subject_id = ${subjectId} AND provider = ${provider} AND revoked_at IS NULL
  `;
  let identity = existing;
  if (!identity) {
    identity = {
      issuer: provider === "google"
        ? "https://accounts.google.com"
        : `https://login.microsoftonline.com/${FIXTURE_MICROSOFT_TENANT}/v2.0`,
      subject_key: provider === "google" ? `fixture-${subjectId}` : subjectId,
    };
    await seed`
      INSERT INTO core.external_identities (
        id, tenant_id, subject_id, provider, issuer, subject_key, idp_tenant, linked_via
      ) VALUES (
        ${randomUUID()}, ${tenantId}, ${subjectId}, ${provider}, ${identity.issuer}, ${identity.subject_key},
        ${provider === "microsoft" ? FIXTURE_MICROSOFT_TENANT : null}, 'link'
      )
    `;
  }

  const state = randomUUID();
  const binding = randomUUID();
  const transactionId = randomUUID();
  const [started] = await sql<{ status: string }[]>`
    SELECT status FROM core.start_oidc_transaction(
      ${transactionId}, ${provider}::core.oidc_provider, 'sign_in', ${sha256Hex(state)}, ${sha256Hex(binding)},
      ${sha256Hex(randomUUID())}, ${randomBytes(48)}, ${`http://localhost:3000/auth/oidc/${provider}/callback`},
      NULL, NULL, NULL, ${randomUUID()}
    )
  `;
  if (started?.status !== "started") throw new Error(`transaction not started: ${started?.status}`);
  const [claimed] = await sql<{ status: string }[]>`
    SELECT status FROM core.claim_oidc_transaction(${sha256Hex(state)}, ${sha256Hex(binding)}, ${provider}::core.oidc_provider, NULL)
  `;
  if (claimed?.status !== "claimed") throw new Error(`transaction not claimed: ${claimed?.status}`);

  const token = newSessionToken();
  const sessionId = randomUUID();
  const [completed] = await sql<{ status: string }[]>`
    SELECT status FROM core.complete_oidc_sign_in(
      ${transactionId}, ${identity.issuer}, ${identity.subject_key}, ${sessionId}, ${hashToken(token)},
      ${SESSION_TTL_SECONDS}
    )
  `;
  if (completed?.status !== "session_created") throw new Error(`no session: ${completed?.status}`);
  return { token, sessionId };
}

/** Raises a session through the test-only elevation below, in the session's tenant. */
async function elevate(
  sql: postgres.Sql,
  tenantId: string,
  sessionId: string,
  factor: "passkey" | "totp" | "recovery_code",
): Promise<void> {
  await withTenant(sql, { tenantId }, (tx) =>
    tx`SELECT test_support.elevate_session(${sessionId}, ${factor}::core.session_second_factor)`,
  );
}

/**
 * The test-only elevation behind `issueTestSession`. Created over the superuser connection, owned
 * by it, and granted to the application role; it bypasses no check the table holds — it writes
 * the proof rows a ceremony writes. The fixture passkey and TOTP are per subject and reused, and
 * their key material is random filler: nothing ever verifies against them.
 */
const TEST_ELEVATION_SQL = `
  CREATE SCHEMA IF NOT EXISTS test_support;
  GRANT USAGE ON SCHEMA test_support TO mpc_app;
  CREATE OR REPLACE FUNCTION test_support.elevate_session(
    p_session UUID, p_factor core.session_second_factor
  ) RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $fn$
  DECLARE
    v core.sessions;
    v_proof UUID := gen_random_uuid();
    v_challenge UUID := gen_random_uuid();
    v_credential UUID;
    v_totp UUID;
    v_code UUID := gen_random_uuid();
  BEGIN
    SELECT * INTO v FROM core.sessions
    WHERE id = p_session AND tenant_id = core.current_tenant() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'no session % in the current tenant', p_session; END IF;

    IF p_factor = 'passkey' THEN
      SELECT id INTO v_credential FROM core.webauthn_credentials
      WHERE credential_id = 'fixture-' || replace(v.subject_id::text, '-', '');
      IF v_credential IS NULL THEN
        v_credential := gen_random_uuid();
        INSERT INTO core.webauthn_credentials (
          id, tenant_id, subject_id, credential_id, public_key, aaguid, user_verified, device_type,
          backed_up, name
        ) VALUES (
          v_credential, v.tenant_id, v.subject_id, 'fixture-' || replace(v.subject_id::text, '-', ''),
          (uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), '00000000-0000-0000-0000-000000000000', true, 'singleDevice', false,
          'Fixture passkey'
        );
      END IF;
      INSERT INTO core.webauthn_challenges (
        id, tenant_id, subject_id, session_id, purpose, challenge, expires_at, consumed_at,
        consumed_by_session_id
      ) VALUES (
        v_challenge, v.tenant_id, v.subject_id, v.id, 'authentication',
        rtrim(translate(encode((uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'base64'), '+/', '-_'), '='),
        now() + interval '5 minutes', now(), v.id
      );
      INSERT INTO core.session_factor_proofs (
        id, tenant_id, subject_id, session_id, factor, webauthn_challenge_id, webauthn_credential_id
      ) VALUES (v_proof, v.tenant_id, v.subject_id, v.id, 'passkey', v_challenge, v_credential);
    ELSIF p_factor = 'totp' THEN
      SELECT id INTO v_totp FROM core.totp_authenticators
      WHERE subject_id = v.subject_id AND confirmed_at IS NOT NULL AND revoked_at IS NULL;
      IF v_totp IS NULL THEN
        v_totp := gen_random_uuid();
        INSERT INTO core.totp_authenticators (
          id, tenant_id, subject_id, secret_ciphertext, secret_nonce, pending_expires_at, confirmed_at
        ) VALUES (
          v_totp, v.tenant_id, v.subject_id, (uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())),
          substring(uuid_send(gen_random_uuid()) FROM 1 FOR 12), now(), now()
        );
      END IF;
      INSERT INTO core.session_factor_proofs (
        id, tenant_id, subject_id, session_id, factor, totp_authenticator_id, totp_step
      ) VALUES (
        v_proof, v.tenant_id, v.subject_id, v.id, 'totp', v_totp,
        (extract(epoch FROM clock_timestamp()) * 1000000)::bigint
      );
    ELSE
      INSERT INTO core.recovery_codes (
        id, tenant_id, subject_id, set_id, code_hash, consumed_at, consumed_by_session_id
      ) VALUES (
        v_code, v.tenant_id, v.subject_id, gen_random_uuid(), encode(sha256(uuid_send(gen_random_uuid())), 'hex'),
        now(), v.id
      );
      INSERT INTO core.session_factor_proofs (
        id, tenant_id, subject_id, session_id, factor, recovery_code_id
      ) VALUES (v_proof, v.tenant_id, v.subject_id, v.id, 'recovery_code', v_code);
    END IF;

    UPDATE core.sessions
    SET second_factor = p_factor, second_factor_at = now(), second_factor_proof_id = v_proof,
        recovery_limited = (p_factor = 'recovery_code')
    WHERE id = v.id;
  END
  $fn$;
  REVOKE EXECUTE ON FUNCTION test_support.elevate_session(UUID, core.session_second_factor) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION test_support.elevate_session(UUID, core.session_second_factor) TO mpc_app;
`;

/**
 * Issues a service token the way the operator CLI does (`service-token-cli.ts`), over the
 * migration connection (`fx.sql`). The subject must be a service subject.
 */
export async function issueTestServiceToken(
  sql: postgres.Sql,
  input: {
    readonly tenantId: string;
    readonly subjectId: string;
    readonly scopes: readonly ("scan_result" | "cre_report")[];
    readonly label?: string;
    readonly ttlSeconds?: number;
  },
): Promise<string> {
  const { token } = await issueServiceToken(sql, {
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    scopes: input.scopes,
    label: input.label ?? "test-service",
    ttlSeconds: input.ttlSeconds ?? 24 * 60 * 60,
  });
  return token;
}

/**
 * Mirrors the admin bind for fixtures that insert wallets directly: identity assurance is the
 * subject's (0108), and a bind states it. Raises each subject to the highest level among its
 * active wallets, exactly as the 0108 backfill did for existing rows.
 */
export async function syncSubjectAssurance(sql: postgres.Sql | postgres.TransactionSql): Promise<void> {
  await sql`
    UPDATE core.subjects s
    SET assurance_level = w.level
    FROM (
      SELECT subject_id, max(assurance_level) AS level
      FROM core.wallet_identities
      WHERE subject_id IS NOT NULL AND disabled_at IS NULL
      GROUP BY subject_id
    ) w
    WHERE w.subject_id = s.id AND s.assurance_level < w.level
  `;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function setupFixture(): Promise<TestFixture> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = postgres(url, { onnotice: () => {} });
  await runMigrations(sql);

  await sql.unsafe(`
    DO $$
    BEGIN
      CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
    GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login;
  `);
  await sql.unsafe(TEST_ELEVATION_SQL);

  const appUrl = new URL(url);
  appUrl.username = "mpc_app_login";
  appUrl.password = "app";
  const appSql = postgres(appUrl.toString(), { onnotice: () => {} });

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const operatorA = newAccount();
  const operatorB = newAccount();
  const readerA = newAccount();
  let operatorSubjectA = "";

  for (const [tenant, org, wallet, label, role] of [
    [tenantA, orgA, operatorA, "Operator A", "mpc_operator"],
    [tenantB, orgB, operatorB, "Operator B", "mpc_operator"],
  ] as const) {
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenant}, ${`t-${tenant.slice(0, 8)}`}, ${label})
    `;
    await sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${org}, ${tenant}, ${`Org ${label}`}, 'MNG')
    `;
    const subject = randomUUID();
    if (tenant === tenantA) operatorSubjectA = subject;
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
      VALUES (${subject}, ${tenant}, 'person', ${label}, 'high_assurance')
    `;
    await sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${tenant}, ${subject}, ${wallet.address}, 31337, 'high_assurance', now()
      )
    `;
    await sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${tenant}, ${subject}, ${org}, ${role})
    `;
  }

  // Subject in tenant A with no role. Needed to tell 401 (unregistered) apart from
  // 403 (insufficient permission).
  const readerSubject = randomUUID();
  await sql`
    INSERT INTO core.subjects (id, tenant_id, kind, display_name)
    VALUES (${readerSubject}, ${tenantA}, 'person', 'Reader A')
  `;
  await sql`
    INSERT INTO core.wallet_identities (
      id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
    ) VALUES (
      ${randomUUID()}, ${tenantA}, ${readerSubject}, ${readerA.address}, 31337, 'wallet_only', now()
    )
  `;

  // reviewer and gate approver. Separation of duties (02 §2.4) needs distinct subjects —
  // if one person reviews and approves, the separation rule cannot be tested.
  const reviewerA = newAccount();
  const approverA = newAccount();
  const stewardA = newAccount();
  // Scan service. Separated so an uploader cannot pass their own file.
  const scanServiceA = newAccount();
  // Separate proposer and voter. With one person, separation of duties cannot be tested.
  const proposerA = newAccount();
  const voterA = newAccount();
  // A registrant cannot approve (02 §2.8). A separate approver is needed to test it.
  const auditorA = newAccount();
  // Publishing a registry draft needs a second person (02 §2.8).
  const disclosureApproverA = newAccount();
  // Steward bound to a single project. Must differ from an organization-level binding to
  // test project scope.
  const scopedStewardA = newAccount();
  const scopedStewardSubject = randomUUID();
  const reviewerSubjectA = randomUUID();
  const approverSubject = randomUUID();

  const stewardSubject = randomUUID();
  const scanServiceSubject = randomUUID();
  const proposerSubject = randomUUID();
  const voterSubject = randomUUID();
  const auditorSubject = randomUUID();
  const disclosureApproverSubject = randomUUID();

  const reviewOrgA = randomUUID();
  await sql`
    INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
    VALUES (${reviewOrgA}, ${tenantA}, 'Independent Review Firm A', 'AUS')
  `;

  for (const [subject, wallet, label, role, assurance] of [
    [reviewerSubjectA, reviewerA, "Reviewer A", "reviewer_cp_qp", "high_assurance"],
    [approverSubject, approverA, "Approver A", "gate_approver", "high_assurance"],
    // 02 §2.3: stewards handle sources and claims. mpc_operator only reads metadata.
    [stewardSubject, stewardA, "Steward A", "data_steward", "identity_bound"],
    [scanServiceSubject, scanServiceA, "Scan Service", "scan_service", "high_assurance"],
    [proposerSubject, proposerA, "Proposer A", "protocol_proposer", "identity_bound"],
    // Voting power comes from holdings, not identity (02 §2.3).
    [voterSubject, voterA, "Voter A", "protocol_voter", "wallet_only"],
    // Trusting an authority is a review outcome, not an operations task (02 §2.8).
    [auditorSubject, auditorA, "Auditor A", "auditor", "high_assurance"],
    [
      disclosureApproverSubject,
      disclosureApproverA,
      "Disclosure Approver A",
      "disclosure_approver",
      "high_assurance",
    ],
  ] as const) {
    // The scan service is a service subject (D7): it holds a service token, not a wallet.
    const service = subject === scanServiceSubject;
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
      VALUES (${subject}, ${tenantA}, ${service ? "service" : "person"}, ${label}, ${assurance})
    `;
    if (!service) {
      await sql`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          ${randomUUID()}, ${tenantA}, ${subject}, ${wallet.address}, 31337, ${assurance}, now()
        )
      `;
    }
    const organization = subject === reviewerSubjectA ? reviewOrgA : orgA;
    await sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${tenantA}, ${subject}, ${organization}, ${role})
    `;
  }

  const issuerAuthorityA = randomUUID();
  await sql`
    INSERT INTO core.authorities (
      id, tenant_id, name, jurisdiction, proves, does_not_prove,
      recognized_scope, verification_method, public_disclosure_level, valid_from, state
    ) VALUES (
      ${issuerAuthorityA}, ${tenantA}, 'Professional Institute', 'AUS',
      ARRAY['member_competence'],
      ARRAY['opinion_accuracy','rights_completeness'],
      ARRAY['resource_estimate','mining_right_registration'],
      'verifiable_signed_document', 'public', '2000-01-01', 'accepted'
    )
  `;

  const credentialA = randomUUID();
  await sql`
    INSERT INTO core.credentials (
      id, tenant_id, subject_id, organization_id, issuer_reference, issuer_authority_id,
      credential_type, credential_scope, jurisdiction, issued_at, expires_at, current_status
    ) VALUES (
      ${credentialA}, ${tenantA}, ${reviewerSubjectA}, ${reviewOrgA}, 'AusIMM',
      ${issuerAuthorityA}, 'competent_person', ARRAY['resource_estimate','mining_right_registration'],
      ARRAY['MNG'], now() - interval '1 year', now() + interval '1 year', 'valid'
    )
  `;

  const projectA = randomUUID();
  await sql`
    INSERT INTO core.projects (
      id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
    ) VALUES (
      ${projectA}, ${tenantA}, ${`FIX-${projectA.slice(0, 8)}`}, 'Fixture Project',
      'MNG', ARRAY['copper'], ${orgA}
    )
  `;

  const otherProjectA = randomUUID();
  await sql`
    INSERT INTO core.projects (
      id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
    ) VALUES (
      ${otherProjectA}, ${tenantA}, ${`FIX-${otherProjectA.slice(0, 8)}`}, 'Other Project',
      'MNG', ARRAY['copper'], ${orgA}
    )
  `;

  // Project-level binding. With `project_id` set, it has no effect outside that project.
  await sql`
    INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
    VALUES (${scopedStewardSubject}, ${tenantA}, 'person', 'Scoped Steward A', 'identity_bound')
  `;
  await sql`
    INSERT INTO core.wallet_identities (
      id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
    ) VALUES (
      ${randomUUID()}, ${tenantA}, ${scopedStewardSubject}, ${scopedStewardA.address},
      31337, 'identity_bound', now()
    )
  `;
  await sql`
    INSERT INTO core.role_bindings (
      id, tenant_id, subject_id, organization_id, project_id, role
    ) VALUES (
      ${randomUUID()}, ${tenantA}, ${scopedStewardSubject}, ${orgA}, ${projectA}, 'data_steward'
    )
  `;

  const authorityA = randomUUID();
  await sql`
    INSERT INTO core.authorities (
      id, tenant_id, name, jurisdiction, proves, does_not_prove,
      recognized_scope, verification_method, public_disclosure_level, valid_from, state
    ) VALUES (
      ${authorityA}, ${tenantA}, 'Mineral Resources Authority', 'MNG',
      ARRAY['mining_right_registration'],
      ARRAY['economic_viability','rights_completeness','investment_suitability'],
      ARRAY['mining_license'], 'authenticated_api', 'public', '2015-01-01', 'accepted'
    )
  `;

  const connectionA = randomUUID();
  await sql`
    INSERT INTO core.source_connections (
      id, tenant_id, authority_id, connection_key, collection_method,
      access_basis, secret_reference, state,
      endpoint, authentication_method, adapter_version, source_schema_version,
      schema_fingerprint, response_record_absent_field, response_record_absent_value,
      response_business_error_field
    ) VALUES (
      ${connectionA}, ${tenantA}, ${authorityA}, ${`conn-${connectionA.slice(0, 8)}`},
      'authenticated_api', 'data sharing agreement 2026-01', 'vault://mn/registry', 'active',
      -- .test is a reserved TLD and never resolves, so a test address is not mistaken for a real
      -- authority address. Tests inject fetch, so no request goes out.
      'https://registry.example.test/mineral/licenses', 'none', 'test', 'test',
      -- Response profile. Without a declaration nothing is confirmed, so
      -- happy-path tests need one.
      ARRAY['licenseId'], 'found', 'false', 'error'
    )
  `;

  const scanServiceToken = await issueTestServiceToken(sql, {
    tenantId: tenantA,
    subjectId: scanServiceSubject,
    scopes: ["scan_result"],
    label: "scan-worker",
  });

  const schemaA = randomUUID();
  await sql`
    INSERT INTO core.attestation_schemas (
      id, tenant_id, schema_key, schema_version, attestation_type,
      required_evidence, accepted_authority_types, mandatory_limitations,
      jurisdiction_profile, state
    ) VALUES (
      ${schemaA}, ${tenantA}, 'mining-right-review', '1',
      'professional_signoff', ARRAY['mining_right_registration'],
      ARRAY['government_registry'], ARRAY['legal_effect_not_determined'], 'MNG', 'active'
    )
  `;

  return {
    sql,
    appSql,
    tenantA,
    tenantB,
    orgA,
    orgB,
    operatorA,
    operatorSubjectA,
    operatorB,
    readerA,
    unknownWallet: newAccount(),
    reviewerA,
    approverA,
    stewardA,
    scanServiceA,
    scanServiceToken,
    scanServiceSubjectA: scanServiceSubject,
    proposerA,
    voterA,
    auditorA,
    disclosureApproverA,
    projectA,
    otherProjectA,
    scopedStewardA,
    authorityA,
    connectionA,
    schemaA,
    credentialA,
    issuerAuthorityA,
    reviewOrgA,
    reviewerSubjectA,
    stewardSubjectA: stewardSubject,
    async close() {
      await appSql.end();
      await sql.end();
    },
  };
}

/** Test environment variables. Development config with dev auth enabled. */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WEB_ORIGIN: "http://localhost:3000",
    CHAIN_ID: "31337",
    SESSION_SECRET: "test-session-secret-at-least-32-chars",
    NODE_ENV: "test",
    /**
     * Generous request cap.
     *
     * One test file sends hundreds of requests from the same IP and would hit the production
     * default. `rate-limit.test.ts` tests the cap separately with a low value — disabling it
     * here would leave that behavior unverified anywhere.
     */
    RATE_LIMIT_MAX: "100000",
    AUTH_RATE_LIMIT_MAX: "100000",
    ALLOW_INSECURE_DEV_AUTH: "true",
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

export function idempotencyKey(): string {
  return randomUUID().replace(/-/g, "");
}
