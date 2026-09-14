import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * AC-25 Jurisdiction portability.
 *
 * 지금까지 확인된 것은 "Core에 몽골 기관명이 hard-code되지 않았다"까지였다.
 * 그것은 **없음의 증명**이고, 없다는 것을 아무리 확인해도 두 번째 관할이 실제로
 * 도는지는 알 수 없다.
 *
 * 그래서 합성 관할 하나를 통째로 세우고 같은 경로를 끝까지 돌린다. 여기 쓰이는
 * `ZZZ`는 ISO 3166-1의 user-assigned 영역이며 실제 나라가 아니다 — 실재하는
 * 관할을 시험 데이터로 쓰면 그 나라의 기관명이 fixture에 남는다.
 */
describeDb("두 번째 관할 이식성 (AC-25)", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let stewardToken: string;
  let approverToken: string;

  /** 합성 관할. 실제 나라가 아니다. */
  const JURISDICTION = "ZZZ";
  let authorityId: string;
  let connectionId: string;
  let policySetId: string;
  let projectId: string;

  /**
   * 합성 출처의 응답. 테스트가 그 관할의 기관 역할을 한다.
   *
   * 실제 호출을 내보내지 않는 이유는 속도가 아니라 **합성 관할에는 부를 대상이
   * 없기 때문**이다. 그것이 곧 이 시험의 전제다 — 관할을 세우는 데 실재하는
   * 기관이 필요하면 이식성이 성립하지 않는다.
   */
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ licenseId: "SYNTH-1", status: "valid" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.10"],
    });
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);
    approverToken = await signIn(app, fx.approverA);

    authorityId = randomUUID();
    connectionId = randomUUID();
    policySetId = randomUUID();

    // 관할 하나를 통째로 세운다. Core가 아니라 **데이터**로만 이루어져야 한다는
    // 것이 AC-25의 요구다.
    await fx.sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        ${authorityId}, ${fx.tenantA}, 'Synthetic Cadastre', ${JURISDICTION},
        ARRAY['등록된 광업권의 존재'], ARRAY['광체의 품위', '법적 발행 적법성'],
        ARRAY['mining_right'], 'authenticated_api', 'public', '2020-01-01', 'accepted'
      )
    `;
    await fx.sql`
      INSERT INTO core.source_connections (
        id, tenant_id, authority_id, connection_key, collection_method,
        access_basis, state, endpoint, authentication_method,
        adapter_version, source_schema_version
      ) VALUES (
        ${connectionId}, ${fx.tenantA}, ${authorityId}, ${`synthetic-${randomUUID().slice(0, 8)}`},
        'authenticated_api', '합성 관할 시험용', 'active',
        -- .test는 예약 TLD라 해석되지 않는다. 합성 관할의 주소가 실제 기관
        -- 주소로 오해되지 않게 한다.
        'https://cadastre.example.test/mining/licenses', 'none', 'test', 'test'
      )
    `;
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${policySetId}, ${fx.tenantA}, 'registry-publication-gate', '1.0.0',
        'registry_publication', ${JURISDICTION}, now(),
        ${fx.sql.json(rulesFixture as never)}, 'effective'
      )
    `;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function post(token: string, url: string, payload: unknown) {
    return app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: payload as never,
    });
  }

  it("합성 관할의 프로젝트를 등록한다", async () => {
    const response = await post(operatorToken, "/api/v1/projects", {
      projectKey: `ZZZ-${randomUUID().slice(0, 8)}`,
      name: "Synthetic jurisdiction mine",
      hostCountryIso3: JURISDICTION,
      minerals: ["copper"],
      ownerOrganizationId: fx.orgA,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().hostCountryIso3).toBe(JURISDICTION);
    projectId = response.json().id;
  });

  it("합성 관할의 authority profile이 그대로 조회된다", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/jurisdictions/${JURISDICTION.toLowerCase()}/profile`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.jurisdiction).toBe(JURISDICTION);
    expect(body.authorities.map((item: { name: string }) => item.name)).toContain(
      "Synthetic Cadastre",
    );
    // 몽골 profile의 값이 새어 들어오면 이식이 아니라 복사다.
    expect(JSON.stringify(body)).not.toContain("MNG");
  });

  it("합성 관할의 출처 조회가 receipt를 만든다", async () => {
    const response = await post(
      stewardToken,
      `/api/v1/source-connections/${connectionId}/collect`,
      { projectId, queryBasis: { licenseId: "SYNTH-LICENSE-1" } },
    );

    expect(response.statusCode).toBe(200);
    // 결과가 무엇이든 **receipt가 남는 것**이 요구다. 실패도 사실이다(05 §5.12).
    expect(response.json().receiptId).toBeTruthy();
    expect(response.json().authorityId).toBe(authorityId);
  });

  it("합성 관할 policy set으로 readiness가 평가된다", async () => {
    const response = await post(
      operatorToken,
      `/api/v1/projects/${projectId}/readiness-assessments`,
      { policySetId },
    );

    expect(response.statusCode).toBe(200);
    // 통과 여부가 아니라 **평가가 성립하는가**를 본다. 합성 관할의 프로젝트가
    // 증빙을 다 갖추지 않은 것은 이 테스트의 관심이 아니다.
    expect(["ok", "gap", "blocked"]).toContain(response.json().status);
    expect(response.json().policySetId).toBe(policySetId);
  });

  it("합성 관할의 기록을 Registry에 게시하고 공개로 읽는다", async () => {
    const publicKey = `ZZZ-PUB-${randomUUID().slice(0, 8)}`;
    const published = await post(operatorToken, "/api/v1/registry-entries", {
      registryType: "project",
      subjectId: projectId,
      publicKey,
      projection: {
        stableId: randomUUID(),
        status: "registered",
        version: "1",
        asOf: "2026-08-01T00:00:00.000Z",
        sourceAge: "12",
        staleStatus: "fresh",
        hostCountry: JURISDICTION,
        limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
        legalEffect: "none",
        disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
      },
      // policy version 문자열에도 관할이 박히지 않아야 한다.
      sourceSnapshotHash: `0x${"33".repeat(32)}`,
      policyVersion: "zzz-core-1.0.0",
      schemaVersion: "project-registry-1",
    });
    expect(published.statusCode).toBe(200);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/public/registries/project/${publicKey}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().hostCountry).toBe(JURISDICTION);
  });

  it("합성 관할이 몽골 profile을 건드리지 않는다", async () => {
    // 이식이 성립하려면 두 관할이 서로를 보지 않아야 한다.
    const mongolia = await app.inject({
      method: "GET",
      url: "/api/v1/jurisdictions/mng/profile",
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(mongolia.statusCode).toBe(200);
    expect(
      mongolia.json().authorities.map((item: { name: string }) => item.name),
    ).not.toContain("Synthetic Cadastre");
  });

  it("approver가 합성 관할의 gate를 판정할 수 있다", async () => {
    const assessment = await post(
      operatorToken,
      `/api/v1/projects/${projectId}/readiness-assessments`,
      { policySetId },
    );
    const response = await post(approverToken, `/api/v1/projects/${projectId}/gate-decisions`, {
      gateId: "registry_publication",
      inputAssessmentId: assessment.json().id,
      // gap이 있으면 go가 막힌다(AC-03). 판정 자체가 성립하는지를 보므로
      // 결과에 맞는 값을 고른다.
      decision: assessment.json().status === "ok" ? "go" : "hold",
      rationale: "합성 관할 이식 시험",
    });

    // 관할이 판정 권한을 바꾸지 않는다. 역할이 바꾼다.
    expect(response.statusCode).toBe(200);
  });
});
