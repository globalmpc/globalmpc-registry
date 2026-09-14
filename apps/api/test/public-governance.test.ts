import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PUBLIC_FIELD_ALLOWLIST } from "@mpc/domain";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 무인증 공개 거버넌스와 공개 이력.
 *
 * 검증하는 것은 "목록이 나온다"가 아니라 **공개하기로 한 것만 나가는가**다.
 * project space, `draft`, 투표자 명단 셋이 새면 이 두 endpoint는 공개 경계를
 * 갖지 않은 것이 된다.
 */
describeDb("공개 거버넌스와 공개 이력", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let proposerToken: string;
  let voterToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    proposerToken = await signIn(app, fx.proposerA);
    voterToken = await signIn(app, fx.voterA);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function propose(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${proposerToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        space: "protocol",
        proposalType: "attestation_schema_approval",
        title: "스키마 변경",
        rationale: "현행 스키마가 한계를 담지 못한다",
        eligibleWeight: "100",
        ...body,
      },
    });
  }

  function transition(id: string, version: number, toState: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/transitions`,
      headers: {
        authorization: `Bearer ${proposerToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { toState, reason: "다음 단계" },
    });
  }

  async function openVoting(body: Record<string, unknown> = {}) {
    const created = (await propose(body)).json();
    let version = created.version;
    for (const state of ["review", "announced", "voting"]) {
      version = (await transition(created.id, version, state)).json().version;
    }
    return { id: created.id as string, version: version as number };
  }

  function publicProposals() {
    return app.inject({ method: "GET", url: "/api/v1/public/governance/proposals?limit=100" });
  }

  it("draft 제안은 공개되지 않는다", async () => {
    const draft = (await propose({ title: `DRAFT-${randomUUID().slice(0, 8)}` })).json();

    const listed = (await publicProposals()).json();
    expect(listed.items.map((item: { id: string }) => item.id)).not.toContain(draft.id);
  });

  it("draft를 벗어난 protocol 제안은 로그인 없이 보인다", async () => {
    const opened = await openVoting({ title: `OPEN-${randomUUID().slice(0, 8)}` });

    const response = await publicProposals();
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toContain(opened.id);
  });

  it("project space 제안은 공개되지 않는다", async () => {
    // protocol governance가 특정 프로젝트의 처분을 정하지 않는 것과 짝이다 —
    // 프로젝트 내부 의사결정을 공개 목록에 싣지 않는다.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${proposerToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        space: "project",
        projectId: fx.projectA,
        proposalType: "project_data_room_publication",
        title: `PROJECT-${randomUUID().slice(0, 8)}`,
        rationale: "프로젝트 내부 결정",
        eligibleWeight: "100",
      },
    });

    // 만들어졌든 거절됐든, 공개 목록에는 project space가 한 건도 없어야 한다.
    const listed = (await publicProposals()).json();
    if (created.statusCode === 200 || created.statusCode === 201) {
      expect(listed.items.map((item: { id: string }) => item.id)).not.toContain(
        created.json().id,
      );
    }
    for (const item of listed.items) {
      expect(item).not.toHaveProperty("projectId");
      expect(item).not.toHaveProperty("space");
    }
  });

  it("집계는 내고 투표자는 내지 않는다", async () => {
    const opened = await openVoting({ title: `TALLY-${randomUUID().slice(0, 8)}` });
    await app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${opened.id}/votes`,
      headers: { authorization: `Bearer ${voterToken}`, "idempotency-key": idempotencyKey() },
      payload: { choice: "for", weight: "30" },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/public/governance/proposals/${opened.id}`,
    });

    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.tally.for).toBe("30");
    expect(body.tally.voterCount).toBe(1);
    // 개별 투표자는 subject이고 자연인 식별자로 이어진다(AC-32).
    expect(JSON.stringify(body)).not.toContain(fx.voterA.address);
    expect(body).not.toHaveProperty("votes");
    expect(body).not.toHaveProperty("proposerSubjectId");
  });

  it("무게를 JSON number로 내지 않는다", async () => {
    // NUMERIC(78,0)은 number에 담기지 않는다. 담으면 조용히 반올림된다(ADR-T07).
    const listed = (await publicProposals()).json();
    for (const item of listed.items) {
      expect(typeof item.tally.for).toBe("string");
      expect(typeof item.tally.against).toBe("string");
    }
  });

  it("tenant를 드러내지 않는다", async () => {
    const listed = await publicProposals();

    expect(listed.body).not.toContain(fx.tenantA);
  });

  it("없는 제안은 404다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/governance/proposals/00000000-0000-4000-8000-000000000000",
    });

    expect(response.statusCode).toBe(404);
  });

  it("공개 이력이 덮지 않는 사건 종류를 응답이 밝힌다", async () => {
    // 빈 목록과 "그 종류는 애초에 여기 오지 않는다"를 구분하지 않으면 사용자가
    // "그런 일이 없었다"로 읽는다.
    //
    // 2026-09-09 결정 뒤로 남는 것은 credential 철회 하나다 —
    // 그 "기록"이 사람이라 "일어났다 + 언제 + 어느 기록" 규칙으로 표현되지 않는다.
    const response = await app.inject({ method: "GET", url: "/api/v1/public/disclosures" });

    expect(response.statusCode).toBe(200);
    const kinds = response.json().notCovered.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toEqual(["credential_revocation"]);
    for (const entry of response.json().notCovered) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("suspension·pause·dispute는 이제 덮는다", async () => {
    // 넷 중 셋이 `notCovered`에서 빠졌다. 빠진 것이 실제로 나오는지는 아래
    // 케이스들이 본다 — 여기서는 **범위 선언이 갈라지지 않았는지**만 본다.
    const response = await app.inject({ method: "GET", url: "/api/v1/public/disclosures" });
    const kinds = response.json().notCovered.map((entry: { kind: string }) => entry.kind);

    for (const covered of ["suspension", "pause", "dispute"]) {
      expect(kinds).not.toContain(covered);
    }
  });

  it("철회된 공개 version이 이력에 나오고 allowlist를 지킨다", async () => {
    const publicKey = `DISC-${randomUUID().slice(0, 8)}`;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    // 철회는 저장소 안 경로가 아직 route로 없다. 사건 자체가 만들어지는지가
    // 아니라 **만들어졌을 때 공개 경계를 지키는지**를 본다.
    await fx.sql`
      UPDATE core.registry_entry_versions
      SET status = 'revoked', revoked_at = now()
      WHERE id = ${published.json().id}
    `;

    const events = (await app.inject({ method: "GET", url: "/api/v1/public/disclosures?limit=100" })).json();
    const mine = events.items.find(
      (event: { publicKey: string }) => event.publicKey === publicKey,
    );

    expect(mine).toBeDefined();
    expect(mine.eventKind).toBe("revocation");
    const leaked = Object.keys(mine.registryVersion.projection).filter(
      (field) => !(PUBLIC_FIELD_ALLOWLIST as readonly string[]).includes(field),
    );
    expect(leaked).toEqual([]);

    // registry version에서 온 사건만 이 묶음을 갖는다.
    expect(mine.lifecycle).toBeNull();
    expect(mine.resolvedAt).toBeNull();
  });

  // --- 결정: "일어났다 + 언제 + 어느 기록" ------------------------------

  /**
   * 프로젝트 하나를 만들고 공개 registry entry를 붙인다.
   *
   * **매번 새로 만든다.** `fx.projectA`를 쓰면 한 케이스가 그것을 공개로 만든
   * 뒤 다른 케이스의 "공개되지 않은 프로젝트" 전제가 무너진다 — 실행 순서에
   * 따라 결과가 달라지는 시험은 통과해도 아무것도 보장하지 않는다.
   */
  async function newProject(): Promise<string> {
    const projectId = randomUUID();
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${fx.tenantA}, ${`Q17-${projectId.slice(0, 8)}`}, 'disclosure fixture',
        'MNG', ARRAY['copper'], ${fx.orgA}
      )
    `;
    return projectId;
  }

  async function publishPublic(projectId: string): Promise<string> {
    const publicKey = `Q17-${randomUUID().slice(0, 8)}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
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
          limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(response.statusCode).toBe(200);
    return publicKey;
  }

  /** 응답 하나의 모양. 계약은 `publicDisclosureEvent`가 갖고, 여기서는 읽는 것만 적는다. */
  interface DisclosureEvent {
    readonly eventId: string;
    readonly eventKind: string;
    readonly publicKey: string;
    readonly registryVersion: { readonly projection: Record<string, unknown> } | null;
    readonly lifecycle: { readonly fromState: string; readonly toState: string } | null;
    readonly resolvedAt: string | null;
  }

  async function disclosures(): Promise<{ items: DisclosureEvent[] }> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/disclosures?limit=100",
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  const SECRET_REASON = "정지 사유는 공개되지 않는다 SUSPEND_SECRET";

  it("suspension이 나오되 사유와 행위자는 나오지 않는다", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    await fx.sql`
      INSERT INTO core.project_lifecycle_transitions (
        tenant_id, project_id, from_state, to_state, reason, actor_subject_id
      ) VALUES (
        ${fx.tenantA}, ${projectId}, 'registered', 'suspended', ${SECRET_REASON},
        ${fx.reviewerSubjectA}
      )
    `;

    const body = await disclosures();
    const mine = body.items.find(
      (event) => event.publicKey === publicKey && event.eventKind === "suspension",
    );

    expect(mine).toBeDefined();
    expect(mine?.lifecycle).toEqual({ fromState: "registered", toState: "suspended" });
    expect(mine?.registryVersion).toBeNull();

    // 응답 **전체**에 사유와 행위자 id가 없어야 한다. 필드 하나만 보면 다른
    // 자리로 새어 나가는 것을 놓친다.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET_REASON);
    expect(serialized).not.toContain(fx.reviewerSubjectA);
  });

  it("공개되지 않은 프로젝트의 suspension은 나오지 않는다", async () => {
    // 나가면 **비공개 프로젝트가 있다는 사실 자체**가 드러난다.
    const projectId = await newProject();

    await fx.sql`
      INSERT INTO core.project_lifecycle_transitions (
        tenant_id, project_id, from_state, to_state, reason
      ) VALUES (${fx.tenantA}, ${projectId}, 'registered', 'suspended', '비공개')
    `;

    const body = await disclosures();
    expect(JSON.stringify(body)).not.toContain(projectId);
  });

  it("pause가 나오되 법적 근거와 요구 기관은 나오지 않는다", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    await fx.sql`
      INSERT INTO core.disclosure_restrictions (
        id, tenant_id, project_id, subject_scope, restricted_action_types,
        legal_basis, authority, state, effective_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, ARRAY[]::UUID[], ARRAY['publish'],
        'LEGAL_BASIS_SECRET', 'AUTHORITY_SECRET', 'active', now()
      )
    `;

    const body = await disclosures();
    const mine = body.items.find(
      (event) => event.publicKey === publicKey && event.eventKind === "pause",
    );

    expect(mine).toBeDefined();
    // 아직 풀리지 않았다.
    expect(mine?.resolvedAt).toBeNull();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("LEGAL_BASIS_SECRET");
    expect(serialized).not.toContain("AUTHORITY_SECRET");
  });

  it("발효 전(draft) pause는 나오지 않는다", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    await fx.sql`
      INSERT INTO core.disclosure_restrictions (
        id, tenant_id, project_id, subject_scope, restricted_action_types,
        legal_basis, authority, state
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, ARRAY[]::UUID[], ARRAY['publish'],
        'draft basis', 'draft authority', 'draft'
      )
    `;

    const body = await disclosures();
    const paused = body.items.filter(
      (event) => event.publicKey === publicKey && event.eventKind === "pause",
    );
    expect(paused).toEqual([]);
  });

  it("dispute가 나오되 사유와 제기자는 나오지 않는다", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    const caseId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_cases (id, tenant_id, project_id, schema_id, state)
      VALUES (${caseId}, ${fx.tenantA}, ${projectId}, ${fx.schemaA}, 'draft')
    `;

    const assignmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.assignments (id, tenant_id, case_id, subject_id, credential_id)
      VALUES (${assignmentId}, ${fx.tenantA}, ${caseId}, ${fx.reviewerSubjectA}, ${fx.credentialA})
    `;

    const attestationId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_attestations (
        id, tenant_id, case_id, assignment_id, credential_id, schema_id,
        attestation_type, claim_scope, evidence_snapshot_hash, findings, limitations,
        credential_status_snapshot, method_version, policy_version,
        payload_hash, signature, signer_wallet_address, signed_at, state
      ) VALUES (
        ${attestationId}, ${fx.tenantA}, ${caseId}, ${assignmentId}, ${fx.credentialA},
        ${fx.schemaA}, 'professional_signoff', ARRAY[]::UUID[], ${`0x${"22".repeat(32)}`},
        '{}'::jsonb, 'legal_effect_not_determined', '{}'::jsonb, '1', '1',
        ${`0x${"33".repeat(32)}`}, ${`0x${"44".repeat(65)}`},
        ${fx.reviewerA.address.toLowerCase()}, now(), 'signed'
      )
    `;

    await fx.sql`
      INSERT INTO core.attestation_disputes (
        id, tenant_id, attestation_id, reason_code, detail, raised_by_subject_id
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${attestationId}, 'REASON_CODE_SECRET',
        'DETAIL_SECRET', ${fx.reviewerSubjectA}
      )
    `;

    const body = await disclosures();
    const mine = body.items.find(
      (event) => event.publicKey === publicKey && event.eventKind === "dispute",
    );

    expect(mine).toBeDefined();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("REASON_CODE_SECRET");
    expect(serialized).not.toContain("DETAIL_SECRET");
    // attestation id도 나가지 않는다 — "어느 기록"은 공개된 project entry다.
    expect(serialized).not.toContain(attestationId);
  });
});
