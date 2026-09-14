import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * project lifecycle 전이.
 *
 * `lifecycle_state`는 `draft`에서 움직이지 않았다. 상태기계와 단위 테스트는
 * 있었고 **그것을 호출하는 route가 없었다.**
 *
 * 여기서 지키는 것은 셋이다.
 *
 * 1. 상태기계 밖의 전이는 거절한다.
 * 2. suspension에서의 복귀는 **직전 상태 또는 closure로만** 간다 — 임의 상태로
 *    나오면 suspension이 상태를 세탁하는 수단이 된다.
 * 3. **멈춘 사람은 되돌릴 수 없다.**
 */
describeDb("project lifecycle", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let approverToken: string;
  let issuerToken: string;
  let issuerSubjectId: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    approverToken = await signIn(app, fx.approverA);

    // issuer_officer는 fixture에 없다. lifecycle을 앞으로 미는 역할이므로
    // 여기서 만든다 — 운영 화면이 생기면서 가능해졌다.
    const subject = (
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/subjects",
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: { displayName: "Issuer Officer" },
      })
    ).json();
    issuerSubjectId = subject.id;

    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(generatePrivateKey());
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subject.id},
        ${account.address.toLowerCase()}, 97, 'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subject.id}, ${fx.orgA}, 'issuer_officer')
    `;
    issuerToken = await signIn(app, {
      address: account.address.toLowerCase() as `0x${string}`,
      account,
    });
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function newProject(): Promise<{ id: string; version: number }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectKey: `LC-${randomUUID().slice(0, 8)}`,
        name: "Lifecycle check",
        hostCountryIso3: "MNG",
        minerals: [],
        ownerOrganizationId: fx.orgA,
      },
    });
    return { id: created.json().id, version: created.json().version };
  }

  function transition(token: string, projectId: string, version: number, body: unknown) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/lifecycle-transitions`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: body as never,
    });
  }

  /** draft → registered 는 Registry 게시가 한다. 여기서도 같은 경로를 쓴다. */
  async function register(projectId: string): Promise<number> {
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: projectId,
        publicKey: `LC-${randomUUID().slice(0, 8)}`,
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

    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/lifecycle`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(lifecycle.json().lifecycleState).toBe("registered");
    return lifecycle.json().version;
  }

  it("게시가 draft를 registered로 옮기고 이력에 남는다", async () => {
    const project = await newProject();
    await register(project.id);

    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/lifecycle`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    // 감사 로그와 별개로 **이 프로젝트가 어디를 지나왔나**가 남아야 한다.
    expect(lifecycle.json().transitions).toHaveLength(1);
    expect(lifecycle.json().transitions[0].fromState).toBe("draft");
    expect(lifecycle.json().transitions[0].toState).toBe("registered");
    expect(lifecycle.json().transitions[0].reason).toBeTruthy();
  });

  it("상태기계 밖의 전이는 거절한다", async () => {
    const project = await newProject();
    const version = await register(project.id);

    // registered에서 갈 수 있는 곳은 offering_open과 suspended뿐이다.
    const response = await transition(issuerToken, project.id, version, {
      toState: "retired",
      reason: "건너뛰기",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("LIFECYCLE_TRANSITION_NOT_ALLOWED");
    expect(response.json().details.allowed).toContain("offering_open");
  });

  it("운영자 단독으로 offering을 열 수 없다", async () => {
    const project = await newProject();
    const version = await register(project.id);

    const response = await transition(operatorToken, project.id, version, {
      toState: "offering_open",
      reason: "운영자가 직접",
    });

    // 발행 결정은 발행 결정을 하는 손이 한다.
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("issuer_officer");
  });

  it("이유 없이 전이할 수 없다", async () => {
    const project = await newProject();
    const version = await register(project.id);

    const response = await transition(issuerToken, project.id, version, {
      toState: "offering_open",
      reason: "",
    });

    expect(response.statusCode).toBe(400);
  });

  describe("suspension", () => {
    it("운영자가 혼자 멈출 수 있다", async () => {
      const project = await newProject();
      const version = await register(project.id);

      // 급한 일이다. 2인을 요구하면 그동안 문제가 있는 프로젝트가 계속 돈다.
      const response = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "근거 attestation이 철회됐다",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lifecycleState).toBe("suspended");
      // 복귀 대상을 기억한다(§4.3).
      expect(response.json().priorLifecycleState).toBe("registered");
    });

    it("멈춘 사람은 되돌릴 수 없다", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "근거 attestation이 철회됐다",
      });

      const response = await transition(operatorToken, project.id, suspended.json().version, {
        toState: "registered",
        reason: "내가 멈췄고 내가 되돌린다",
      });

      // 같은 사람이 멈추고 되돌리면 suspension은 통제가 아니라 재량이 된다.
      // 권한 자체도 없지만(operator는 advance가 아니다) 그 앞에 이 규칙이 있다.
      expect([403]).toContain(response.statusCode);
    });

    it("다른 사람이 직전 상태로 되돌린다", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "근거 attestation이 철회됐다",
      });

      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "registered",
        reason: "재검토 결과 문제가 없다",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lifecycleState).toBe("registered");
      // 나오면 복귀 대상을 지운다.
      expect(response.json().priorLifecycleState).toBeNull();
      expect(response.json().transitions).toHaveLength(3);
    });

    it("직전 상태가 아닌 곳으로 나올 수 없다", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "근거 attestation이 철회됐다",
      });

      // registered에서 멈췄는데 active로 나오면 suspension이 상태를 세탁한다.
      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "active",
        reason: "그냥 앞으로",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("LIFECYCLE_RESUME_TARGET_INVALID");
    });

    it("closure로는 언제나 나올 수 있다", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "근거 attestation이 철회됐다",
      });

      // 멈춘 프로젝트를 닫는 것은 세탁이 아니다(§4.3).
      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "closure",
        reason: "사업을 접는다",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lifecycleState).toBe("closure");
    });
  });

  it("If-Match 없이 전이할 수 없다", async () => {
    const project = await newProject();
    await register(project.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/lifecycle-transitions`,
      headers: { authorization: `Bearer ${issuerToken}`, "idempotency-key": idempotencyKey() },
      payload: { toState: "offering_open", reason: "버전 없이" },
    });

    expect(response.statusCode).toBe(428);
  });

  it("approver도 앞으로 미는 전이를 할 수 있다", async () => {
    const project = await newProject();
    const version = await register(project.id);

    const response = await transition(approverToken, project.id, version, {
      toState: "offering_open",
      reason: "gate 판정 결과 진행",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().lifecycleState).toBe("offering_open");
  });
});

describeDb("공개 projection의 lifecycle", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  it("게시 직전 상태가 아니라 게시 이후 상태를 담는다", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectKey: `W39-${randomUUID().slice(0, 8)}`,
        name: "Projection status",
        hostCountryIso3: "MNG",
        minerals: [],
        ownerOrganizationId: fx.orgA,
      },
    });
    const projectId = created.json().id;
    const publicKey = `W39-${randomUUID().slice(0, 8)}`;

    // 화면은 게시 **직전** 상태를 담아 보낸다. 그것이 `draft`다.
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: projectId,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "draft",
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

    // 11 §11.4의 `registered`는 "Registry 기록 존재"이고, 그 기록을 만드는 것이
    // 바로 이 요청이다. 저장되는 순간 이미 draft가 아니다.
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/public/registries/project/${publicKey}`,
    });
    expect(read.statusCode).toBe(200);
    // 응답의 최상위 `status`는 version의 게시 상태이고, projection 안의 것이
    // lifecycle이다.
    const [stored] = await fx.sql<{ public_projection: { status: string } }[]>`
      SELECT public_projection FROM core.registry_entry_versions
      WHERE id = ${published.json().id}
    `;
    expect(stored!.public_projection.status).toBe("registered");
  });

  it("draft가 아닌 상태를 게시가 앞으로 밀지 않는다", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectKey: `W39B-${randomUUID().slice(0, 8)}`,
        name: "Already suspended",
        hostCountryIso3: "MNG",
        minerals: [],
        ownerOrganizationId: fx.orgA,
      },
    });
    const projectId = created.json().id;
    await fx.sql`
      UPDATE core.projects
      SET lifecycle_state = 'suspended', prior_lifecycle_state = 'registered'
      WHERE id = ${projectId}
    `;

    const publicKey = `W39B-${randomUUID().slice(0, 8)}`;
    const published = await app.inject({
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
    expect(published.statusCode).toBe(200);

    // suspended를 게시로 되돌리면 incident closure 없이 복귀시키는 셈이 된다.
    const [stored] = await fx.sql<{ public_projection: { status: string } }[]>`
      SELECT public_projection FROM core.registry_entry_versions
      WHERE id = ${published.json().id}
    `;
    expect(stored!.public_projection.status).toBe("suspended");
  });
});
