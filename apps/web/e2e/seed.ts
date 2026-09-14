import postgres from "postgres";
import { privateKeyToAccount } from "viem/accounts";
import { runMigrations } from "@mpc/db";

/**
 * E2E용 고정 seed.
 *
 * 웹의 `DEMO_ACCOUNTS`가 고정 주소를 쓰므로 seed도 같은 값을 만든다. 랜덤을
 * 쓰면 화면의 계정 카드와 DB가 어긋난다.
 *
 * 매 실행마다 스키마를 다시 만든다 — E2E는 이전 실행의 잔여 데이터에 의존하면
 * 안 된다.
 */

export const E2E_TENANT_A = "e0000000-0000-4000-8000-00000000000a";
export const E2E_TENANT_B = "e0000000-0000-4000-8000-00000000000b";
export const E2E_TENANT_C = "e0000000-0000-4000-8000-00000000000c";
export const E2E_ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
export const E2E_ORG_B = "bbbbbbbb-0000-0000-0000-000000000001";
export const E2E_ORG_C = "cccccccc-1000-0000-0000-000000000001";

/**
 * 데모 계정 주소는 실행 시점에 주어진 키에서 유도한다.
 *
 * **키를 저장소에 두지 않는다.** 두면 그것을 아는 누구나 배포된 주소에서 그
 * 역할로 로그인한다. `playwright.config.ts`가 실행마다 새로 만들어
 * `E2E_DEMO_ACCOUNT_KEYS`로 넘기고, 같은 값이 웹의 `NEXT_PUBLIC_DEMO_ACCOUNT_KEYS`로도
 * 간다 — 화면의 계정 카드와 여기 seed가 같은 키를 보게 하는 것이 목적이다.
 *
 * 주소를 하드코딩하지 않는 이유도 같다. 키와 어긋나면 화면에서 로그인은 되는데
 * 역할이 없는 상태가 된다 — 원인을 찾기 어려운 종류의 불일치다.
 */
const DEMO_KEYS: Readonly<Record<string, string>> = JSON.parse(
  process.env["E2E_DEMO_ACCOUNT_KEYS"] ?? "{}",
) as Record<string, string>;

function addressOfLabel(label: string): string {
  const privateKey = DEMO_KEYS[label];
  if (!privateKey) {
    // 조용히 넘어가면 role_bindings가 엉뚱한 주소에 붙고, 스펙은 "권한 없음"으로
    // 실패한다. 원인이 seed에 있다는 것이 그 실패에서는 보이지 않는다.
    throw new Error(
      `E2E_DEMO_ACCOUNT_KEYS에 "${label}"이 없다. playwright.config.ts를 거쳐 실행한다.`,
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
/** 검사 서비스. 사람이 아니라 시스템 identity다. */
export const SCAN_SERVICE = addressOfLabel("Scan Service");
export const PROPOSER_A = addressOfLabel("Proposer A");
export const VOTER_A = addressOfLabel("Voter A");

/** 검토자 subject·credential·schema. Verification Workbench가 이 id들을 쓴다. */
export const E2E_REVIEWER_SUBJECT = "aaaaaaaa-0000-0000-0000-000000000006";
export const E2E_CREDENTIAL_ID = "eeeeeeee-0000-0000-0000-000000000001";
export const E2E_ATTESTATION_SCHEMA_ID = "eeeeeeee-0000-0000-0000-000000000002";

/** 준비도 화면이 쓰는 규칙 세트. packages/policy의 fixture와 같은 내용이다. */
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
      label: "프로젝트 식별 정보와 책임 주체",
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
      label: "광업권 존재와 유효기간",
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
      // 권한은 있는데 데이터가 없는 계정. "빈 목록"과 "권한 없음"을 화면이
      // 구분하는지 확인하려면 이 상태가 다른 테스트의 영향을 받지 않아야 한다.
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

    // tenant A 소속이지만 역할이 없는 계정. 401(미등록)과 403(권한 부족)을
    // 화면에서 구분해 보여주는지 검증하는 데 쓴다.
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

    // Data Room·준비도 화면이 쓰는 데모 authority·connection·규칙 세트.
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
        -- .test는 예약 TLD라 해석되지 않는다. 시험용 고정값이 실제 기관 주소로
        -- 오해되지 않게 한다 — 실제 endpoint는 OD-42 협의 뒤에 설정으로 들어온다.
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

    // steward·gate approver·reviewer. 역할 분리를 화면에서 확인하려면 별도 계정이
    // 필요하다. 특히 검토자는 gate 결정권자와 같은 사람이면 안 된다(02 §2.4).
    for (const extra of [
      { subject: "aaaaaaaa-0000-0000-0000-000000000004", wallet: STEWARD_A, label: "Steward A", role: "data_steward", assurance: "identity_bound" },
      { subject: "aaaaaaaa-0000-0000-0000-000000000005", wallet: APPROVER_A, label: "Approver A", role: "gate_approver", assurance: "high_assurance" },
      { subject: E2E_REVIEWER_SUBJECT, wallet: REVIEWER_A, label: "Reviewer A", role: "reviewer_cp_qp", assurance: "high_assurance" },
      // 검사 서비스. `upload.scan_result`만 갖는다 — 파일을 올린 사람이 자기
      // 파일을 통과시킬 수 없게 사람 역할과 분리한다.
      { subject: "aaaaaaaa-0000-0000-0000-000000000007", wallet: SCAN_SERVICE, label: "Scan Service", role: "scan_service", assurance: "high_assurance" },
      { subject: "aaaaaaaa-0000-0000-0000-000000000008", wallet: PROPOSER_A, label: "Proposer A", role: "protocol_proposer", assurance: "identity_bound" },
      // 투표권은 보유에서 나오지 신원에서 나오지 않는다(02 §2.3).
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

    // 연동되지 않은 기관과 계획 단계 기관. 목록에서 빼면 "왜 이 기관은 없나"를
    // 알 수 없고, 활성으로 두면 있지도 않은 연동을 약속한다(R5 gate).
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
        'authenticated_api', '접근 협의 예정', 'planned'
      )
    `;

    // 검토자의 자격과 그 자격이 덮는 범위. attestation은 이것 없이 만들 수 없다.
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
        ARRAY['government_registry'], ARRAY['현장 실사를 포함하지 않는다'],
        'MNG', 'active'
      )
    `;

    // tenant B에 프로젝트를 하나 만들어 둔다. tenant A 화면에 이것이 보이면
    // 격리가 깨진 것이다.
    await sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        gen_random_uuid(), ${E2E_TENANT_B}, 'TENANT-B-ONLY', 'Tenant B 전용 프로젝트',
        'MNG', ARRAY['gold'], ${E2E_ORG_B}
      )
    `;
  } finally {
    await sql.end();
  }
}

// CLI 진입점은 `seed-cli.ts`에 있다. Playwright가 이 모듈을 CJS로 로드하므로
// 여기서 `import.meta`를 쓰면 globalSetup이 깨진다.
