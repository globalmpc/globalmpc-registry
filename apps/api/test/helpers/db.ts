import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { runMigrations } from "@mpc/db";

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
  /** Address not registered in any tenant */
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
  /** tenant A · scan_service. System identity that can only produce scan results */
  readonly scanServiceA: TestAccount;
  /** tenant A · protocol_proposer. Creates governance proposals */
  readonly proposerA: TestAccount;
  /** tenant A · protocol_voter. Only votes */
  readonly voterA: TestAccount;
  /** tenant A · auditor. Decides authority approval (02 §2.8) */
  readonly auditorA: TestAccount;
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
  /** Valid credential of reviewerA */
  readonly credentialA: string;
  /** Subject id of reviewerA */
  readonly reviewerSubjectA: string;
  close(): Promise<void>;
}

/**
 * Creates an account together with its private key.
 *
 * From R1, authentication is SIWE signature → session token. Tests need a signing key to
 * log in, so an address alone is not enough.
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
 * Performs a SIWE login and obtains a session token.
 *
 * The dev wallet-header path is removed, so every authenticated test goes through here.
 * Tests running at all is evidence that "the real auth flow works".
 */
export async function signIn(app: FastifyInstance, account: TestAccount): Promise<string> {
  const nonceResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/siwe/nonce",
    payload: { walletAddress: account.address, chainId: 97 },
  });
  const { nonce, statement, uri } = nonceResponse.json() as {
    nonce: string;
    statement: string;
    uri: string;
  };

  const message = createSiweMessage({
    address: account.account.address,
    chainId: 97,
    domain: "localhost:3000",
    nonce,
    statement,
    uri,
    version: "1",
    issuedAt: new Date(),
  });
  const signature = await account.account.signMessage({ message });

  const verified = await app.inject({
    method: "POST",
    url: "/api/v1/auth/siwe/verify",
    payload: { message, signature },
  });

  const token = (verified.json() as { sessionToken: string | null }).sessionToken;
  if (!token) throw new Error("did not receive a session token");
  return token;
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
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${tenant}, 'person', ${label})
    `;
    await sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${tenant}, ${subject}, ${wallet.address}, 97, 'high_assurance', now()
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
      ${randomUUID()}, ${tenantA}, ${readerSubject}, ${readerA.address}, 97, 'wallet_only', now()
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
  ] as const) {
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${tenantA}, 'person', ${label})
    `;
    await sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${tenantA}, ${subject}, ${wallet.address}, 97, ${assurance}, now()
      )
    `;
    await sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${tenantA}, ${subject}, ${orgA}, ${role})
    `;
  }

  const credentialA = randomUUID();
  await sql`
    INSERT INTO core.credentials (
      id, tenant_id, subject_id, organization_id, issuer_reference,
      credential_type, credential_scope, jurisdiction, issued_at, expires_at, current_status
    ) VALUES (
      ${credentialA}, ${tenantA}, ${reviewerSubjectA}, ${orgA}, 'AusIMM',
      'competent_person', ARRAY['resource_estimate','mining_right_registration'],
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
    INSERT INTO core.subjects (id, tenant_id, kind, display_name)
    VALUES (${scopedStewardSubject}, ${tenantA}, 'person', 'Scoped Steward A')
  `;
  await sql`
    INSERT INTO core.wallet_identities (
      id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
    ) VALUES (
      ${randomUUID()}, ${tenantA}, ${scopedStewardSubject}, ${scopedStewardA.address},
      97, 'identity_bound', now()
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
      -- Response profile — 2026-09-10 audit A7. Without a declaration nothing is confirmed, so
      -- happy-path tests need one.
      ARRAY['licenseId'], 'found', 'false', 'error'
    )
  `;

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
    proposerA,
    voterA,
    auditorA,
    projectA,
    otherProjectA,
    scopedStewardA,
    authorityA,
    connectionA,
    schemaA,
    credentialA,
    reviewerSubjectA,
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
    SIWE_DOMAIN: "localhost:3000",
    SIWE_URI: "http://localhost:3000",
    CHAIN_ID: "97",
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
