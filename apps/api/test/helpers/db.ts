import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { runMigrations } from "@mpc/db";

/**
 * 테스트 DB 헬퍼.
 *
 * `packages/db`의 헬퍼와 달리 스키마를 드롭하지 않는다. 이 계층의 테스트는
 * 스키마 lifecycle이 아니라 그 위의 동작을 검증하므로, **매 파일이 고유 tenant를
 * 만들어 격리**한다. 드롭을 하면 같은 인스턴스를 쓰는 다른 테스트가 깨진다.
 */
export interface TestFixture {
  /** superuser 연결. seed에 쓴다. */
  readonly sql: postgres.Sql;
  /** 애플리케이션 role 연결. RLS가 적용된다. */
  readonly appSql: postgres.Sql;
  readonly tenantA: string;
  readonly tenantB: string;
  readonly orgA: string;
  readonly orgB: string;
  /** tenant A · mpc_operator · high_assurance */
  readonly operatorA: TestAccount;
  /** tenant B · mpc_operator · high_assurance */
  readonly operatorB: TestAccount;
  /** tenant A · 역할 없음 · wallet_only */
  readonly readerA: TestAccount;
  /** 어느 tenant에도 등록되지 않은 주소 */
  readonly unknownWallet: TestAccount;
  /** tenant A · reviewer_cp_qp · high_assurance */
  readonly reviewerA: TestAccount;
  /** tenant A · gate_approver · high_assurance */
  readonly approverA: TestAccount;
  /** tenant A · data_steward · identity_bound. evidence·claim을 다룬다(02 §2.3) */
  readonly stewardA: TestAccount;
  /**
   * tenant A · data_steward · **projectA에만 묶인 바인딩**.
   *
   * 조직 수준 바인딩과 프로젝트 수준 바인딩의 차이를 시험하려면 둘 다 필요하다.
   * 이 계정은 `projectA`에서는 steward지만 `otherProjectA`에서는 아무것도 아니다.
   */
  readonly scopedStewardA: TestAccount;
  /** tenant A · scan_service. 검사 결과만 만들 수 있는 시스템 identity */
  readonly scanServiceA: TestAccount;
  /** tenant A · protocol_proposer. 거버넌스 제안을 만든다 */
  readonly proposerA: TestAccount;
  /** tenant A · protocol_voter. 투표만 한다 */
  readonly voterA: TestAccount;
  /** tenant A · auditor. authority 승인을 판정한다(02 §2.8) */
  readonly auditorA: TestAccount;
  /** operatorA의 subject id. 등록자와 승인자가 같은지 보는 데 쓴다 */
  readonly operatorSubjectA: string;
  /** tenant A에 미리 만들어 둔 프로젝트 */
  readonly projectA: string;
  /** 같은 tenant의 다른 프로젝트. project scope 밖을 시험한다 */
  readonly otherProjectA: string;
  /** tenant A의 accepted authority */
  readonly authorityA: string;
  /** tenant A의 active source connection */
  readonly connectionA: string;
  /** tenant A의 active attestation schema */
  readonly schemaA: string;
  /** reviewerA의 유효한 credential */
  readonly credentialA: string;
  /** reviewerA의 subject id */
  readonly reviewerSubjectA: string;
  close(): Promise<void>;
}

/**
 * 계정을 private key와 함께 만든다.
 *
 * R1부터 인증은 SIWE 서명 → 세션 토큰이다. 테스트가 로그인하려면 서명할 키가
 * 있어야 하므로 주소만 만들 수 없다.
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
 * SIWE 로그인을 수행해 세션 토큰을 얻는다.
 *
 * 개발용 wallet 헤더 경로가 제거됐으므로 모든 인증 테스트가 이 경로를 지난다.
 * 즉 테스트가 도는 것 자체가 "실제 인증 흐름이 동작한다"는 증거다.
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
  if (!token) throw new Error("세션 토큰을 받지 못했다");
  return token;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function setupFixture(): Promise<TestFixture> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL이 필요하다");

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

  // tenant A에 속하지만 역할이 없는 주체. 401(미등록)과 403(권한 부족)을
  // 구분해 검증하기 위해 필요하다.
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

  // reviewer와 gate approver. 권한 분리(02 §2.4)를 검증하려면 서로 다른 주체가
  // 필요하다 — 같은 사람이 검토하고 승인하면 분리 규칙을 시험할 수 없다.
  const reviewerA = newAccount();
  const approverA = newAccount();
  const stewardA = newAccount();
  // 검사 서비스. 파일을 올린 사람이 자기 파일을 통과시킬 수 없게 분리한다.
  const scanServiceA = newAccount();
  // 제안자와 투표자를 나눈다. 같은 사람이면 권한 분리를 시험할 수 없다.
  const proposerA = newAccount();
  const voterA = newAccount();
  // 등록한 사람은 승인할 수 없다(02 §2.8). 승인자를 따로 둬야 시험할 수 있다.
  const auditorA = newAccount();
  // 프로젝트 하나에만 묶인 steward. 조직 수준 바인딩과 구분해야 project scope를
  // 시험할 수 있다.
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
    // 02 §2.3: source·claim을 다루는 것은 steward다. mpc_operator는 metadata만 읽는다.
    [stewardSubject, stewardA, "Steward A", "data_steward", "identity_bound"],
    [scanServiceSubject, scanServiceA, "Scan Service", "scan_service", "high_assurance"],
    [proposerSubject, proposerA, "Proposer A", "protocol_proposer", "identity_bound"],
    // 투표권은 보유에서 나오지 신원에서 나오지 않는다(02 §2.3).
    [voterSubject, voterA, "Voter A", "protocol_voter", "wallet_only"],
    // 기관을 신뢰하기로 하는 것은 운영 작업이 아니라 검토 결과다(02 §2.8).
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

  // 프로젝트 수준 바인딩. `project_id`가 채워지면 그 프로젝트 밖에서는 통하지 않는다.
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
      -- .test는 예약 TLD라 해석되지 않는다. 시험용 주소가 실제 기관 주소로
      -- 오해되지 않게 한다. 테스트는 fetch를 주입하므로 나가지 않는다.
      'https://registry.example.test/mineral/licenses', 'none', 'test', 'test',
      -- 응답 profile — 2026-09-10 실사 A7. 선언이 없으면 확정되지 않으므로
      -- 정상 경로 시험에는 선언이 있어야 한다.
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

/** 테스트용 환경변수. dev auth를 켠 development 설정이다. */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SIWE_DOMAIN: "localhost:3000",
    SIWE_URI: "http://localhost:3000",
    CHAIN_ID: "97",
    SESSION_SECRET: "test-session-secret-at-least-32-chars",
    NODE_ENV: "test",
    /**
     * 요청 상한을 넉넉히 둔다.
     *
     * 한 테스트 파일이 같은 IP로 수백 번 요청하므로 운영 기본값이면 상한에
     * 걸린다. 상한 자체는 `rate-limit.test.ts`가 낮은 값으로 서버를 세워
     * 따로 시험한다 — 여기서 끄면 그 동작이 어디서도 검증되지 않는다.
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
