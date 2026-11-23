import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { inject } from "vitest";
import { withActor } from "@mpc/db";
import { prepareTemplate } from "./template.js";
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
 * behavior on top of the schema, not its lifecycle, so **each fixture gets its own database**,
 * cloned from a migrated template and dropped by `close()`. The Registry has no tenant to
 * isolate a test by any more, and its catalog keys (schema keys, claim types, policy sets) are
 * unique across the whole database, so two fixtures in one database would collide.
 */
export interface TestFixture {
  /** Superuser connection. Used for seeding. */
  readonly sql: postgres.Sql;
  /** Application role connection. RLS applies. */
  readonly appSql: postgres.Sql;
  readonly orgA: string;
  readonly orgB: string;
  /** administrator, Registry-wide · high_assurance */
  readonly operatorA: TestAccount;
  /**
   * Company B: administrator of `orgB` only (an organization-scoped binding) · high_assurance.
   * Reaches the projects orgB owns and nothing of company A's.
   */
  readonly operatorB: TestAccount;
  readonly operatorSubjectB: string;
  /** no role · wallet_only */
  readonly readerA: TestAccount;
  /** A key bound to no subject. `signIn` refuses it: a wallet alone signs nobody in (WP7). */
  readonly unknownWallet: TestAccount;
  /** reviewer · high_assurance */
  readonly reviewerA: TestAccount;
  /** reviewer · high_assurance */
  readonly approverA: TestAccount;
  /** reviewer · identity_bound. handles evidence and claims (02 §2.3) */
  readonly stewardA: TestAccount;
  /**
   * reviewer · **binding scoped to projectA only**.
   *
   * Both are needed to test organization-level versus project-level bindings.
   * This account is a steward in `projectA` but nothing in `otherProjectA`.
   */
  readonly scopedStewardA: TestAccount;
  /**
   * scan_service, a **service** subject. Holds no wallet and cannot `signIn`; it
   * authenticates with `scanServiceToken` (D7).
   */
  readonly scanServiceA: TestAccount;
  /** Service token of the scan service, scoped to `scan_result`. */
  readonly scanServiceToken: string;
  readonly scanServiceSubjectA: string;
  /** project_member. Creates governance proposals */
  readonly proposerA: TestAccount;
  /** project_member. Only votes */
  readonly voterA: TestAccount;
  /** administrator. Decides authority approval (02 §2.8) */
  readonly auditorA: TestAccount;
  /** reviewer. Publishes what an operator drafted (02 §2.8) */
  readonly disclosureApproverA: TestAccount;
  /** operatorA's subject id. Used to check whether registrant and approver are the same */
  readonly operatorSubjectA: string;
  /** Pre-created project owned by orgA */
  readonly projectA: string;
  /** Another project of orgA. Tests access outside project scope */
  readonly otherProjectA: string;
  /** Accepted authority */
  readonly authorityA: string;
  /** Active source connection */
  readonly connectionA: string;
  /** Active attestation schema */
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
  const [holder] = await seedConnection()<{ subject_id: string }[]>`
    SELECT w.subject_id
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
  return issueTestSession(appConnection(), holder.subject_id, {
    firstFactor: "email_code",
  });
}

/** Migration-role connection the session helper seeds with. Opened on first use. */
let seedSql: { url: string; sql: postgres.Sql } | null = null;
function seedConnection(): postgres.Sql {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");
  if (seedSql?.url !== url) {
    void seedSql?.sql.end();
    seedSql = { url, sql: postgres(url, { onnotice: () => {}, max: 1, idle_timeout: 2 }) };
  }
  return seedSql.sql;
}

/**
 * Application-role connection `signIn` issues sessions over — the role the API itself uses, as
 * `issueTestSession` expects. `setupFixture` creates the login role first. Opened on first use.
 */
let appSqlShared: { url: string; sql: postgres.Sql } | null = null;
function appConnection(): postgres.Sql {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");
  if (appSqlShared?.url !== url) {
    void appSqlShared?.sql.end();
    const appUrl = new URL(url);
    appUrl.username = "mpc_app_login";
    appUrl.password = "app";
    appSqlShared = { url, sql: postgres(appUrl.toString(), { onnotice: () => {}, max: 2, idle_timeout: 2 }) };
  }
  return appSqlShared.sql;
}

/** Closes the shared connections of a fixture database before it is dropped. */
async function endSharedConnections(url: string): Promise<void> {
  for (const shared of [seedSql, appSqlShared]) {
    if (shared?.url === url) await shared.sql.end();
  }
  if (seedSql?.url === url) seedSql = null;
  if (appSqlShared?.url === url) appSqlShared = null;
}

/**
 * Issues a session for a subject through the real database path a login flow uses. Use it to
 * test what a session at a given AAL may do.
 *
 * - `google`: the login-transaction path itself (0121). Such a session exists only
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
  subjectId: string,
  factors: {
    readonly firstFactor: "email_code" | "google";
    readonly secondFactor?: "passkey" | "totp" | "recovery_code" | null;
  },
): Promise<string> {
  const firstFactor = factors.firstFactor;
  if (firstFactor !== "email_code") {
    const issued = await oidcTestSession(sql, subjectId, firstFactor);
    if (factors.secondFactor) await elevate(sql, subjectId, issued.sessionId, factors.secondFactor);
    return issued.token;
  }

  const seed = seedConnection();
  const [subject] = await seed<{ email: string }[]>`
    UPDATE core.subjects SET email = COALESCE(email, ${`session-${subjectId}@example.test`})
    WHERE id = ${subjectId} AND kind = 'person'
    RETURNING email
  `;
  if (!subject) throw new Error(`no person subject ${subjectId}`);

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

  if (factors.secondFactor) await elevate(sql, subjectId, sessionId, factors.secondFactor);
  return token;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** A sign-in session for `subjectId` through 0121's functions; see `issueTestSession`. */
async function oidcTestSession(
  sql: postgres.Sql,
  subjectId: string,
  provider: "google",
): Promise<{ token: string; sessionId: string }> {
  const seed = seedConnection();
  const [person] = await seed`
    SELECT 1 FROM core.subjects WHERE id = ${subjectId} AND kind = 'person'
  `;
  if (!person) throw new Error(`no person subject ${subjectId}`);
  const [existing] = await seed<{ issuer: string; subject_key: string }[]>`
    SELECT issuer, subject_key FROM core.external_identities
    WHERE subject_id = ${subjectId} AND provider = ${provider} AND revoked_at IS NULL
  `;
  let identity = existing;
  if (!identity) {
    identity = {
      issuer: "https://accounts.google.com",
      subject_key: `fixture-${subjectId}`,
    };
    await seed`
      INSERT INTO core.external_identities (
        id, subject_id, provider, issuer, subject_key, linked_via
      ) VALUES (
        ${randomUUID()}, ${subjectId}, ${provider}, ${identity.issuer}, ${identity.subject_key}, 'link'
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

/** Raises a session through the test-only elevation below, acting as the session's subject. */
async function elevate(
  sql: postgres.Sql,
  subjectId: string,
  sessionId: string,
  factor: "passkey" | "totp" | "recovery_code",
): Promise<void> {
  await withActor(sql, { subjectId }, (tx) =>
    tx`SELECT test_support.elevate_session(${sessionId}, ${factor}::core.session_second_factor)`,
  );
}


/**
 * Issues a service token the way the operator CLI does (`service-token-cli.ts`), over the
 * migration connection (`fx.sql`). The subject must be a service subject.
 */
export async function issueTestServiceToken(
  sql: postgres.Sql,
  input: {
    readonly subjectId: string;
    readonly scopes: readonly ("scan_result" | "cre_report")[];
    readonly label?: string;
    readonly ttlSeconds?: number;
  },
): Promise<string> {
  const { token } = await issueServiceToken(sql, {
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

/**
 * The database a test run was pointed at. Fixtures never write to it: it only hosts the migrated
 * template and creates and drops the per-fixture copies.
 */
const BASE_DATABASE_URL = process.env["DATABASE_URL"];
let templateReady: Promise<string> | null = null;

/** The template the project's global setup migrated, or one this process migrates itself. */
function templateFor(admin: postgres.Sql, base: URL): Promise<string> {
  const provided = inject("apiTemplate");
  if (provided) return Promise.resolve(provided);
  // Run outside the root configuration (no global setup): migrate it here, once per process.
  templateReady ??= prepareTemplate(admin, base);
  return templateReady;
}

/** A fresh database for one fixture, cloned from the migrated template. */
async function createFixtureDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  if (!BASE_DATABASE_URL) throw new Error("DATABASE_URL is required");
  const base = new URL(BASE_DATABASE_URL);
  const admin = postgres(BASE_DATABASE_URL, { onnotice: () => {}, max: 1 });
  try {
    const template = await templateFor(admin, base);
    const name = `${template.replace(/_api_template$/, "")}_fx_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    const url = new URL(base);
    url.pathname = `/${name}`;
    return {
      url: url.toString(),
      async drop() {
        const dropper = postgres(BASE_DATABASE_URL!, { onnotice: () => {}, max: 1 });
        try {
          await dropper.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        } finally {
          await dropper.end();
        }
      },
    };
  } catch (error) {
    templateReady = null;
    throw error;
  } finally {
    await admin.end();
  }
}

/** A migrated Registry with nothing in it: no organization, person or role. */
export interface BareRegistry {
  /** Superuser connection. Used for seeding. */
  readonly sql: postgres.Sql;
  /** Application role connection. RLS applies. */
  readonly appSql: postgres.Sql;
  close(): Promise<void>;
}

/**
 * A database of its own with no fixture rows, for tests that need a Registry holding exactly
 * what they seed (the last administrator, a first bootstrap). Like `setupFixture`, it points
 * `DATABASE_URL` at itself until `close()`.
 */
export async function setupBareRegistry(): Promise<BareRegistry> {
  const database = await createFixtureDatabase();
  const previousUrl = process.env["DATABASE_URL"];
  // Everything a test builds after this — the app's config (`testEnv`), the session helpers,
  // its own connections — reaches this database.
  process.env["DATABASE_URL"] = database.url;
  const url = database.url;
  const sql = postgres(url, { onnotice: () => {} });
  const appUrl = new URL(url);
  appUrl.username = "mpc_app_login";
  appUrl.password = "app";
  const appSql = postgres(appUrl.toString(), { onnotice: () => {} });
  return {
    sql,
    appSql,
    async close() {
      await appSql.end();
      await sql.end();
      await endSharedConnections(url);
      if (process.env["DATABASE_URL"] === url) process.env["DATABASE_URL"] = previousUrl;
      await database.drop();
    },
  };
}

export async function setupFixture(): Promise<TestFixture> {
  const registry = await setupBareRegistry();
  const { sql, appSql } = registry;

  const orgA = randomUUID();
  const orgB = randomUUID();
  const operatorA = newAccount();
  const operatorB = newAccount();
  const readerA = newAccount();
  const operatorSubjectA = randomUUID();
  const operatorSubjectB = randomUUID();

  // Operator A administers the Registry; operator B administers company B only.
  for (const [subject, org, wallet, label, scope] of [
    [operatorSubjectA, orgA, operatorA, "Operator A", "registry"],
    [operatorSubjectB, orgB, operatorB, "Operator B", "organization"],
  ] as const) {
    await sql`
      INSERT INTO core.organizations (id, legal_name, jurisdiction)
      VALUES (${org}, ${`Org ${label}`}, 'MNG')
    `;
    await sql`
      INSERT INTO core.subjects (id, kind, display_name, assurance_level)
      VALUES (${subject}, 'person', ${label}, 'high_assurance')
    `;
    await sql`
      INSERT INTO core.wallet_identities (
        id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${subject}, ${wallet.address}, 31337, 'high_assurance', now()
      )
    `;
    await sql`
      INSERT INTO core.role_bindings (id, subject_id, organization_id, role, scope_kind)
      VALUES (${randomUUID()}, ${subject}, ${org}, 'administrator', ${scope})
    `;
  }

  // A person with no role. Needed to tell 401 (unregistered) apart from
  // 403 (insufficient permission).
  const readerSubject = randomUUID();
  await sql`
    INSERT INTO core.subjects (id, kind, display_name)
    VALUES (${readerSubject}, 'person', 'Reader A')
  `;
  await sql`
    INSERT INTO core.wallet_identities (
      id, subject_id, wallet_address, chain_id, assurance_level, bound_at
    ) VALUES (
      ${randomUUID()}, ${readerSubject}, ${readerA.address}, 31337, 'wallet_only', now()
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
    INSERT INTO core.organizations (id, legal_name, jurisdiction)
    VALUES (${reviewOrgA}, 'Independent Review Firm A', 'AUS')
  `;

  for (const [subject, wallet, label, role, assurance] of [
    [reviewerSubjectA, reviewerA, "Reviewer A", "reviewer", "high_assurance"],
    [approverSubject, approverA, "Approver A", "reviewer", "high_assurance"],
    // 02 §2.3: stewards handle sources and claims. administrator only reads metadata.
    [stewardSubject, stewardA, "Steward A", "reviewer", "high_assurance"],
    [scanServiceSubject, scanServiceA, "Scan Service", "scan_service", "high_assurance"],
    [proposerSubject, proposerA, "Proposer A", "project_member", "identity_bound"],
    // Voting power comes from holdings, not identity (02 §2.3).
    [voterSubject, voterA, "Voter A", "project_member", "identity_bound"],
    // Trusting an authority is a review outcome, not an operations task (02 §2.8).
    [auditorSubject, auditorA, "Auditor A", "administrator", "high_assurance"],
    [
      disclosureApproverSubject,
      disclosureApproverA,
      "Disclosure Approver A",
      "reviewer",
      "high_assurance",
    ],
  ] as const) {
    // The scan service is a service subject (D7): it holds a service token, not a wallet.
    const service = subject === scanServiceSubject;
    await sql`
      INSERT INTO core.subjects (id, kind, display_name, assurance_level)
      VALUES (${subject}, ${service ? "service" : "person"}, ${label}, ${assurance})
    `;
    if (!service) {
      await sql`
        INSERT INTO core.wallet_identities (
          id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          ${randomUUID()}, ${subject}, ${wallet.address}, 31337, ${assurance}, now()
        )
      `;
    }
    const organization = subject === reviewerSubjectA ? reviewOrgA : orgA;
    await sql`
      INSERT INTO core.role_bindings (id, subject_id, organization_id, role, scope_kind)
      VALUES (${randomUUID()}, ${subject}, ${organization}, ${role},
        ${subject === stewardSubject || role === "project_member" ? "organization" : "registry"})
    `;
  }

  const issuerAuthorityA = randomUUID();
  await sql`
    INSERT INTO core.authorities (
      id, name, jurisdiction, proves, does_not_prove,
      recognized_scope, verification_method, public_disclosure_level, valid_from, state
    ) VALUES (
      ${issuerAuthorityA}, 'Professional Institute', 'AUS',
      ARRAY['member_competence'],
      ARRAY['opinion_accuracy','rights_completeness'],
      ARRAY['resource_estimate','mining_right_registration'],
      'verifiable_signed_document', 'public', '2000-01-01', 'accepted'
    )
  `;

  const credentialA = randomUUID();
  await sql`
    INSERT INTO core.credentials (
      id, subject_id, organization_id, issuer_reference, issuer_authority_id,
      credential_type, credential_scope, jurisdiction, issued_at, expires_at, current_status
    ) VALUES (
      ${credentialA}, ${reviewerSubjectA}, ${reviewOrgA}, 'AusIMM',
      ${issuerAuthorityA}, 'competent_person', ARRAY['resource_estimate','mining_right_registration'],
      ARRAY['MNG'], now() - interval '1 year', now() + interval '1 year', 'valid'
    )
  `;

  const projectA = randomUUID();
  await sql`
    INSERT INTO core.projects (
      id, project_key, name, host_country_iso3, minerals, owner_organization_id
    ) VALUES (
      ${projectA}, ${`FIX-${projectA.slice(0, 8)}`}, 'Fixture Project',
      'MNG', ARRAY['copper'], ${orgA}
    )
  `;

  const otherProjectA = randomUUID();
  await sql`
    INSERT INTO core.projects (
      id, project_key, name, host_country_iso3, minerals, owner_organization_id
    ) VALUES (
      ${otherProjectA}, ${`FIX-${otherProjectA.slice(0, 8)}`}, 'Other Project',
      'MNG', ARRAY['copper'], ${orgA}
    )
  `;

  // Project-level binding. With `project_id` set, it has no effect outside that project.
  await sql`
    INSERT INTO core.subjects (id, kind, display_name, assurance_level)
    VALUES (${scopedStewardSubject}, 'person', 'Scoped Steward A', 'high_assurance')
  `;
  await sql`
    INSERT INTO core.wallet_identities (
      id, subject_id, wallet_address, chain_id, assurance_level, bound_at
    ) VALUES (
      ${randomUUID()}, ${scopedStewardSubject}, ${scopedStewardA.address},
      31337, 'identity_bound', now()
    )
  `;
  await sql`
    INSERT INTO core.role_bindings (
      id, subject_id, organization_id, project_id, role
    ) VALUES (
      ${randomUUID()}, ${scopedStewardSubject}, ${orgA}, ${projectA}, 'reviewer'
    )
  `;

  const authorityA = randomUUID();
  await sql`
    INSERT INTO core.authorities (
      id, name, jurisdiction, proves, does_not_prove,
      recognized_scope, verification_method, public_disclosure_level, valid_from, state
    ) VALUES (
      ${authorityA}, 'Mineral Resources Authority', 'MNG',
      ARRAY['mining_right_registration'],
      ARRAY['economic_viability','rights_completeness','investment_suitability'],
      ARRAY['mining_license'], 'authenticated_api', 'public', '2015-01-01', 'accepted'
    )
  `;

  const connectionA = randomUUID();
  await sql`
    INSERT INTO core.source_connections (
      id, authority_id, connection_key, collection_method,
      access_basis, secret_reference, state,
      endpoint, authentication_method, adapter_version, source_schema_version,
      schema_fingerprint, response_record_absent_field, response_record_absent_value,
      response_business_error_field
    ) VALUES (
      ${connectionA}, ${authorityA}, ${`conn-${connectionA.slice(0, 8)}`},
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
    subjectId: scanServiceSubject,
    scopes: ["scan_result"],
    label: "scan-worker",
  });

  const schemaA = randomUUID();
  await sql`
    INSERT INTO core.attestation_schemas (
      id, schema_key, schema_version, attestation_type,
      required_evidence, accepted_authority_types, mandatory_limitations,
      jurisdiction_profile, state
    ) VALUES (
      ${schemaA}, 'mining-right-review', '1',
      'professional_signoff', ARRAY['mining_right_registration'],
      ARRAY['government_registry'], ARRAY['legal_effect_not_determined'], 'MNG', 'active'
    )
  `;

  return {
    sql,
    appSql,
    orgA,
    orgB,
    operatorA,
    operatorSubjectA,
    operatorB,
    operatorSubjectB,
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
    close: () => registry.close(),
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
