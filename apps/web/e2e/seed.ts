import postgres from "postgres";
import { privateKeyToAccount } from "viem/accounts";
import { runMigrations } from "@mpc/db";

/**
 * Fixed seed for E2E.
 *
 * The web's `DEMO_ACCOUNTS` use fixed addresses, so the seed produces the same values.
 * Random values would make the account cards on screen diverge from the DB.
 *
 * The schema is recreated on every run — E2E must not depend on leftover data from a
 * previous run.
 */

export const E2E_TENANT_A = "e0000000-0000-4000-8000-00000000000a";
export const E2E_TENANT_B = "e0000000-0000-4000-8000-00000000000b";
export const E2E_TENANT_C = "e0000000-0000-4000-8000-00000000000c";
export const E2E_ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
export const E2E_ORG_B = "bbbbbbbb-0000-0000-0000-000000000001";
export const E2E_ORG_C = "cccccccc-1000-0000-0000-000000000001";

/**
 * Demo account addresses are derived from keys supplied at run time.
 *
 * **Keys are not kept in the repository.** If they were, anyone who knows them could
 * sign in with that role on a deployed address. `playwright.config.ts` generates them
 * fresh on every run and passes them as `E2E_DEMO_ACCOUNT_KEYS`; the same value also goes
 * to the web as `NEXT_PUBLIC_DEMO_ACCOUNT_KEYS` — so the account cards on screen and this
 * seed see the same keys.
 *
 * Addresses are not hardcoded for the same reason. If they diverge from the keys, sign-in
 * succeeds on screen but no role is attached — a mismatch whose cause is hard to find.
 */
const DEMO_KEYS: Readonly<Record<string, string>> = JSON.parse(
  process.env["E2E_DEMO_ACCOUNT_KEYS"] ?? "{}",
) as Record<string, string>;

function addressOfLabel(label: string): string {
  const privateKey = DEMO_KEYS[label];
  if (!privateKey) {
    // Passing silently would attach role_bindings to the wrong address, and specs would
    // fail with "no permission". That failure does not reveal that the cause is the seed.
    throw new Error(
      `E2E_DEMO_ACCOUNT_KEYS has no "${label}". Run through playwright.config.ts.`,
    );
  }
  return privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase();
}

export const OPERATOR_A = addressOfLabel("Operator A");
export const OPERATOR_B = addressOfLabel("Operator B");
export const READER_A = addressOfLabel("Reader A");
export const OPERATOR_C = addressOfLabel("Operator C");
export const STEWARD_A = addressOfLabel("Steward A");
export const APPROVER_A = addressOfLabel("Approver A");
export const REVIEWER_A = addressOfLabel("Reviewer A");
/** Scan service. A system identity, not a person. */
export const SCAN_SERVICE = addressOfLabel("Scan Service");
export const PROPOSER_A = addressOfLabel("Proposer A");
export const VOTER_A = addressOfLabel("Voter A");

/** Reviewer subject, credential and schema. The Verification Workbench uses these ids. */
export const E2E_REVIEWER_SUBJECT = "aaaaaaaa-0000-0000-0000-000000000006";
export const E2E_CREDENTIAL_ID = "eeeeeeee-0000-0000-0000-000000000001";
export const E2E_ATTESTATION_SCHEMA_ID = "eeeeeeee-0000-0000-0000-000000000002";

/** Rule set used by the readiness screen. Same content as the fixture in packages/policy. */
const RULE_SET = {
  ruleSetId: "registry-publication-gate",
  version: "1.0.0",
  effectiveFrom: "2026-01-01T00:00:00Z",
  supersededBy: null,
  jurisdictionProfile: "MNG",
  gateId: "registry_publication",
  retroactive: false,
  requirements: [
    {
      requirementId: "project-identity",
      label: "Project identity and responsible party",
      appliesWhen: { op: "always" },
      requiredClaimTypes: ["project_identity"],
      minimumGrade: "self_reported",
      freshnessThresholdDays: null,
      requiredAttestations: [],
      blockingConflictTypes: [],
      notEvaluableWhen: { op: "never" },
      watchWhen: null,
    },
    {
      requirementId: "mining-right",
      label: "Mining right existence and validity period",
      appliesWhen: { op: "always" },
      requiredClaimTypes: ["mining_right_registration"],
      minimumGrade: "partially_verified",
      freshnessThresholdDays: "180",
      requiredAttestations: [],
      blockingConflictTypes: ["rights_conflict"],
      notEvaluableWhen: { op: "never" },
      watchWhen: null,
    },
  ],
};

export async function seedE2eDatabase(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { onnotice: () => {} });

  try {
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS core CASCADE;
      DROP SCHEMA IF EXISTS chain CASCADE;
      DROP SCHEMA IF EXISTS audit CASCADE;
    `);
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

    const accounts = [
      {
        tenant: E2E_TENANT_A,
        slug: "tenant-a",
        org: E2E_ORG_A,
        subject: "aaaaaaaa-0000-0000-0000-000000000002",
        wallet: OPERATOR_A,
        label: "Operator A",
        assurance: "high_assurance",
        role: "mpc_operator",
      },
      {
        tenant: E2E_TENANT_B,
        slug: "tenant-b",
        org: E2E_ORG_B,
        subject: "bbbbbbbb-0000-0000-0000-000000000002",
        wallet: OPERATOR_B,
        label: "Operator B",
        assurance: "high_assurance",
        role: "mpc_operator",
      },
      // An account with permission but no data. To check that the screen distinguishes
      // "empty list" from "no permission", this state must not be affected by other tests.
      {
        tenant: E2E_TENANT_C,
        slug: "tenant-c",
        org: E2E_ORG_C,
        subject: "cccccccc-1000-0000-0000-000000000002",
        wallet: OPERATOR_C,
        label: "Operator C",
        assurance: "high_assurance",
        role: "mpc_operator",
      },
    ] as const;

    for (const account of accounts) {
      await sql`
        INSERT INTO core.tenants (id, slug, display_name)
        VALUES (${account.tenant}, ${account.slug}, ${account.label})
      `;
      await sql`
        INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
        VALUES (${account.org}, ${account.tenant}, ${`MPC Operations ${account.slug}`}, 'MNG')
      `;
      await sql`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name)
        VALUES (${account.subject}, ${account.tenant}, 'person', ${account.label})
      `;
      await sql`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          gen_random_uuid(), ${account.tenant}, ${account.subject}, ${account.wallet},
          97, ${account.assurance}, now()
        )
      `;
      await sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (
          gen_random_uuid(), ${account.tenant}, ${account.subject}, ${account.org}, ${account.role}
        )
      `;
    }

    // An account in tenant A without a role. Used to verify that the screen distinguishes
    // 401 (not registered) from 403 (insufficient permission).
    const readerSubject = "aaaaaaaa-0000-0000-0000-000000000003";
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${readerSubject}, ${E2E_TENANT_A}, 'person', 'Reader A')
    `;
    await sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        gen_random_uuid(), ${E2E_TENANT_A}, ${readerSubject}, ${READER_A}, 97, 'wallet_only', now()
      )
    `;

    // Demo authority, connection and rule set used by the Data Room and readiness screens.
    await sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        'cccccccc-0000-0000-0000-000000000001', ${E2E_TENANT_A},
        'Mineral Resources Authority', 'MNG',
        ARRAY['mining_right_registration'],
        ARRAY['economic_viability','rights_completeness','investment_suitability'],
        ARRAY['mining_license'], 'authenticated_api', 'public', '2015-01-01', 'accepted'
      )
    `;
    await sql`
      INSERT INTO core.source_connections (
        id, tenant_id, authority_id, connection_key, collection_method,
        access_basis, secret_reference, state,
        endpoint, authentication_method, adapter_version, source_schema_version
      ) VALUES (
        'cccccccc-0000-0000-0000-000000000002', ${E2E_TENANT_A},
        'cccccccc-0000-0000-0000-000000000001', 'mn-mineral-registry',
        'authenticated_api', 'data sharing agreement 2026-01', 'vault://mn/registry', 'active',
        -- .test is a reserved TLD and does not resolve. This keeps the test fixture from
        -- being mistaken for a real agency address — the real endpoint arrives via config after the OD-42 agreement.
        'https://registry.example.test/mineral/licenses', 'none', 'e2e', 'e2e'
      )
    `;
    await sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        'dddddddd-0000-0000-0000-000000000001', ${E2E_TENANT_A},
        'registry-publication-gate', '1.0.0', 'registry_publication', 'MNG',
        now(), ${sql.json(RULE_SET as never)}, 'effective'
      )
    `;

    // steward, gate approver, reviewer. Checking role separation on screen needs separate
    // accounts. In particular, the reviewer must not be the same person as the gate decider (02 §2.4).
    for (const extra of [
      { subject: "aaaaaaaa-0000-0000-0000-000000000004", wallet: STEWARD_A, label: "Steward A", role: "data_steward", assurance: "identity_bound" },
      { subject: "aaaaaaaa-0000-0000-0000-000000000005", wallet: APPROVER_A, label: "Approver A", role: "gate_approver", assurance: "high_assurance" },
      { subject: E2E_REVIEWER_SUBJECT, wallet: REVIEWER_A, label: "Reviewer A", role: "reviewer_cp_qp", assurance: "high_assurance" },
      // Scan service. Holds only `upload.scan_result` — kept separate from human roles so
      // the person who uploads a file cannot pass their own file.
      { subject: "aaaaaaaa-0000-0000-0000-000000000007", wallet: SCAN_SERVICE, label: "Scan Service", role: "scan_service", assurance: "high_assurance" },
      { subject: "aaaaaaaa-0000-0000-0000-000000000008", wallet: PROPOSER_A, label: "Proposer A", role: "protocol_proposer", assurance: "identity_bound" },
      // Voting rights come from holdings, not from identity (02 §2.3).
      { subject: "aaaaaaaa-0000-0000-0000-000000000009", wallet: VOTER_A, label: "Voter A", role: "protocol_voter", assurance: "wallet_only" },
    ]) {
      await sql`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name)
        VALUES (${extra.subject}, ${E2E_TENANT_A}, 'person', ${extra.label})
      `;
      await sql`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          gen_random_uuid(), ${E2E_TENANT_A}, ${extra.subject}, ${extra.wallet},
          97, ${extra.assurance}, now()
        )
      `;
      await sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (gen_random_uuid(), ${E2E_TENANT_A}, ${extra.subject}, ${E2E_ORG_A}, ${extra.role})
      `;
    }

    // An unintegrated authority and a planned-stage authority. Leaving them out of the list
    // hides "why is this authority missing"; marking them active promises an integration that does not exist (R5 gate).
    await sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        'cccccccc-0000-0000-0000-000000000003', ${E2E_TENANT_A},
        'Land Administration Office', 'MNG',
        ARRAY['land_use_right'],
        ARRAY['economic_viability','environmental_compliance'],
        ARRAY['land'], 'manual_official_registry_confirmation', 'public', '2018-01-01', 'accepted'
      )
    `;
    await sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        'cccccccc-0000-0000-0000-000000000004', ${E2E_TENANT_A},
        'Environmental Agency', 'MNG',
        ARRAY['environmental_permit'],
        ARRAY['economic_viability','rights_completeness'],
        ARRAY['environment'], 'authenticated_api', 'public', '2019-01-01', 'accepted'
      )
    `;
    await sql`
      INSERT INTO core.source_connections (
        id, tenant_id, authority_id, connection_key, collection_method,
        access_basis, state
      ) VALUES (
        'cccccccc-0000-0000-0000-000000000005', ${E2E_TENANT_A},
        'cccccccc-0000-0000-0000-000000000004', 'mn-environmental',
        'authenticated_api', 'Access agreement planned', 'planned'
      )
    `;

    // The reviewer's credential and the scope it covers. An attestation cannot be created without it.
    await sql`
      INSERT INTO core.credentials (
        id, tenant_id, subject_id, organization_id, issuer_reference,
        credential_type, credential_scope, jurisdiction, issued_at, expires_at,
        current_status
      ) VALUES (
        ${E2E_CREDENTIAL_ID}, ${E2E_TENANT_A}, ${E2E_REVIEWER_SUBJECT}, ${E2E_ORG_A},
        'AusIMM CP(Geology) #123456', 'competent_person',
        ARRAY['mining_right_registration','resource_estimate'], ARRAY['MNG','AUS'],
        '2024-01-01', '2030-01-01', 'valid'
      )
    `;
    await sql`
      INSERT INTO core.attestation_schemas (
        id, tenant_id, schema_key, schema_version, attestation_type,
        required_evidence, accepted_authority_types, mandatory_limitations,
        jurisdiction_profile, state
      ) VALUES (
        ${E2E_ATTESTATION_SCHEMA_ID}, ${E2E_TENANT_A}, 'mining-right-signoff', '1',
        'professional_signoff', ARRAY['mining_right_registration'],
        ARRAY['government_registry'], ARRAY['Does not include site due diligence'],
        'MNG', 'active'
      )
    `;

    // Create one project in tenant B. If it shows up on tenant A's screens, isolation is broken.
    await sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        gen_random_uuid(), ${E2E_TENANT_B}, 'TENANT-B-ONLY', 'Tenant B only project',
        'MNG', ARRAY['gold'], ${E2E_ORG_B}
      )
    `;
  } finally {
    await sql.end();
  }
}

// The CLI entry point is in `seed-cli.ts`. Playwright loads this module as CJS, so using
// `import.meta` here breaks globalSetup.
