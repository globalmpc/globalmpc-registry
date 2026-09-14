import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Authority Registry 운영 경로 — 02 §2.8, REQ-DAPP-043.
 *
 * 이 파일이 보는 것은 **분리가 실제로 강제되는가**다. 문서에 적힌 분리는
 * 라우트가 막지 않으면 존재하지 않는다.
 */
describeDb("Authority Registry 쓰기", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let auditor: string;
  let steward: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    auditor = await signIn(app, fx.auditorA);
    steward = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  let counter = 0;
  function register(token = operator, overrides: Record<string, unknown> = {}) {
    counter += 1;
    return app.inject({
      method: "POST",
      url: "/api/v1/authorities",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        name: `Test Authority ${counter}`,
        jurisdiction: "MNG",
        proves: ["mining_right_registration"],
        doesNotProve: ["economic_viability"],
        recognizedScope: ["mining_license"],
        verificationMethod: "authenticated_api",
        publicDisclosureLevel: "public",
        validFrom: "2020-01-01",
        reason: "몽골 광업권 등록부 후보",
        ...overrides,
      },
    });
  }

  function setState(id: string, version: number, state: string, token = auditor) {
    return app.inject({
      method: "POST",
      url: `/api/v1/authorities/${id}/state`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { state, reason: `${state}로 전환한다` },
    });
  }

  it("등록은 항상 proposed에서 시작한다", async () => {
    const response = await register();
    expect(response.statusCode).toBe(201);

    const body = response.json();
    // 요청이 상태를 정할 수 있으면 등록하는 사람이 승인까지 하게 된다.
    expect(body.state).toBe("proposed");
    expect(body.version).toBe(1);
  });

  it("한계가 비어 있으면 등록되지 않는다", async () => {
    // 한계 없는 authority는 존재하지 않는다(05 §5.11).
    const response = await register(operator, { doesNotProve: [] });
    expect(response.statusCode).toBe(400);
  });

  it("등록한 사람은 같은 기관을 승인할 수 없다", async () => {
    const created = (await register()).json();

    // operatorA에게 auditor 역할을 더해 권한만으로는 통과하게 만든다.
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (gen_random_uuid(), ${fx.tenantA}, ${fx.operatorSubjectA}, ${fx.orgA}, 'auditor')
    `;
    const bothRoles = await signIn(app, fx.operatorA);

    const response = await setState(created.id, created.version, "accepted", bothRoles);

    // 권한 검사만으로는 막지 못한다. 등록자와 승인자가 같은지를 따로 본다.
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("SEPARATION_OF_DUTIES");

    await fx.sql`
      DELETE FROM core.role_bindings
      WHERE subject_id = ${fx.operatorSubjectA} AND role = 'auditor'
    `;
  });

  it("운영자 역할만으로는 상태를 바꿀 수 없다", async () => {
    const created = (await register()).json();
    // 02 §2.8: 운영자 단독 accepted 전환 금지.
    const response = await setState(created.id, created.version, "accepted", operator);
    expect(response.statusCode).toBe(403);
  });

  it("독립 검토자는 승인할 수 있다", async () => {
    const created = (await register()).json();
    const response = await setState(created.id, created.version, "accepted");

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("accepted");
  });

  it("정지·취소에는 이유가 필요하다", async () => {
    const created = (await register()).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/authorities/${created.id}/state`,
      headers: {
        authorization: `Bearer ${auditor}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${created.version}"`,
      },
      payload: { state: "revoked", reason: "" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("If-Match 없이 상태를 바꿀 수 없다", async () => {
    const created = (await register()).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/authorities/${created.id}/state`,
      headers: { authorization: `Bearer ${auditor}`, "idempotency-key": idempotencyKey() },
      payload: { state: "accepted", reason: "확인했다" },
    });

    expect(response.statusCode).toBe(428);
  });

  it("변경마다 이력이 남는다", async () => {
    const created = (await register()).json();

    await app.inject({
      method: "PATCH",
      url: `/api/v1/authorities/${created.id}`,
      headers: {
        authorization: `Bearer ${operator}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${created.version}"`,
      },
      payload: { doesNotProve: ["economic_viability", "title_validity"], reason: "한계를 넓힌다" },
    });

    const versions = (
      await app.inject({
        method: "GET",
        url: `/api/v1/authorities/${created.id}/versions`,
        headers: { authorization: `Bearer ${operator}` },
      })
    ).json().items as { version: number; doesNotProve: string[]; changeReason: string }[];

    expect(versions).toHaveLength(2);
    // 그때 이 기관이 무엇을 확인해 주지 않는다고 했는지가 남아야 한다.
    expect(versions[0]?.doesNotProve).toContain("title_validity");
    expect(versions[1]?.doesNotProve).not.toContain("title_validity");
    expect(versions[1]?.changeReason).toBe("몽골 광업권 등록부 후보");
  });

  it("이력은 수정할 수 없다", async () => {
    await expect(
      fx.sql`UPDATE core.authority_versions SET change_reason = '바꿈' WHERE version = 1`,
    ).rejects.toThrow(/수정하거나 삭제할 수 없다/);
  });

  describe("연동", () => {
    async function makeAccepted() {
      const created = (await register()).json();
      const accepted = (await setState(created.id, created.version, "accepted")).json();
      return accepted.id as string;
    }

    function createConnection(authorityId: string, body: Record<string, unknown> = {}) {
      counter += 1;
      return app.inject({
        method: "POST",
        url: `/api/v1/authorities/${authorityId}/connections`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: {
          connectionKey: `conn-test-${counter}`,
          collectionMethod: "authenticated_api",
          accessBasis: "data sharing agreement",
          reason: "연동을 구성한다",
          ...body,
        },
      });
    }

    it("승인되지 않은 기관의 연동은 활성이 될 수 없다", async () => {
      const created = (await register()).json();

      // 02 §2.8이 금지하는 것: API 성공을 authority 승인으로 변환하는 것.
      const response = await createConnection(created.id, {
        state: "active",
        endpoint: "https://registry.example.test/x",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_REQUIRES_ACCEPTED_AUTHORITY");
    });

    it("승인된 기관의 연동은 활성이 된다", async () => {
      const authorityId = await makeAccepted();
      const response = await createConnection(authorityId, {
        state: "active",
        endpoint: "https://registry.example.test/x",
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().state).toBe("active");
    });

    it("자격증명 값을 반환하지 않는다", async () => {
      const authorityId = await makeAccepted();
      const created = (await createConnection(authorityId, {
        secretReference: "vault://mn/registry",
      })).json();

      expect(created.hasSecret).toBe(true);
      // 참조 문자열 자체도 응답에 없다.
      expect(JSON.stringify(created)).not.toContain("vault://");
    });

    // AC-04·AC-21: source가 승인을 잃으면 그것에 의존하는 하위가 함께 상태를
    // 바꾼다. 여기서 덮는 것은 authority→connection 구간이다 —
    // claim→attestation→Registry 전파는 아직 없다.
    it("기관이 승인을 잃으면 연동이 내려간다", async () => {
      const authorityId = await makeAccepted();
      const connection = (await createConnection(authorityId, {
        state: "active",
        endpoint: "https://registry.example.test/x",
      })).json();

      const [before] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.authorities WHERE id = ${authorityId}
      `;

      const suspended = await setState(authorityId, before!.version, "suspended");
      expect(suspended.statusCode).toBe(200);
      // 화면이 다시 조회하지 않아도 알 수 있게 응답이 말한다.
      expect(suspended.json().connectionsDegraded).toBe(true);

      const [row] = await fx.sql<{ state: string }[]>`
        SELECT state::text FROM core.source_connections WHERE id = ${connection.id}
      `;
      // 정지시켰는데 연동이 계속 active면 정지의 의미가 사라진다.
      expect(row?.state).toBe("degraded");
    });

    it("연동 구성 권한이 없는 역할은 만들 수 없다", async () => {
      const authorityId = await makeAccepted();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/authorities/${authorityId}/connections`,
        headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
        payload: {
          connectionKey: "conn-denied",
          collectionMethod: "authenticated_api",
          accessBasis: "x",
          reason: "시도",
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it("endpoint를 갱신할 수 있다", async () => {
      const authorityId = await makeAccepted();
      const created = (await createConnection(authorityId)).json();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/source-connections/${created.id}`,
        headers: {
          authorization: `Bearer ${operator}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${created.version}"`,
        },
        payload: {
          endpoint: "https://registry.example.test/v2",
          state: "active",
          reason: "새 주소로 옮긴다",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().endpoint).toBe("https://registry.example.test/v2");
      expect(response.json().version).toBe(created.version + 1);
    });
  });
});
