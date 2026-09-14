import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("프로젝트 라우트", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorA: string; operatorB: string; readerA: string; unknownWallet: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // R1부터 인증은 SIWE 서명 → 세션 토큰이다. 테스트도 같은 경로를 지난다.
    tokens = {
      operatorA: await signIn(app, fx.operatorA),
      operatorB: await signIn(app, fx.operatorB),
      readerA: await signIn(app, fx.readerA),
      unknownWallet: await signIn(app, fx.unknownWallet),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function body(overrides: Record<string, unknown> = {}) {
    return {
      projectKey: `TEST-${idempotencyKey().slice(0, 8)}`,
      name: "테스트 프로젝트",
      hostCountryIso3: "MNG",
      minerals: ["copper"],
      ownerOrganizationId: fx.orgA,
      ...overrides,
    };
  }

  function create(wallet: string, payload: Record<string, unknown>, key = idempotencyKey()) {
    return app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${wallet}`, "idempotency-key": key },
      payload,
    });
  }

  describe("등록", () => {
    it("권한 있는 operator가 등록한다", async () => {
      const response = await create(tokens.operatorA, body());
      expect(response.statusCode).toBe(200);

      const created = response.json();
      expect(created.lifecycleState).toBe("draft");
      expect(created.version).toBe(1);
      expect(created.readinessSummary).toBeNull();
      // 07 §7.1: 모든 응답에 requestId·asOf가 있다.
      expect(created.requestId).toBeTruthy();
      expect(created.asOf).toBeTruthy();
    });

    it("등록이 audit과 outbox를 같은 트랜잭션에 남긴다", async () => {
      const payload = body();
      const response = await create(tokens.operatorA, payload);
      const created = response.json();

      const audits = await fx.sql`
        SELECT command, effective_role, after_version FROM audit.events
        WHERE resource_id = ${created.id}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]!["command"]).toBe("project.registered");
      expect(audits[0]!["effective_role"]).toBe("mpc_operator");

      const events = await fx.sql`
        SELECT event_type, published_at FROM core.outbox WHERE aggregate_id = ${created.id}
      `;
      expect(events).toHaveLength(1);
      expect(events[0]!["published_at"]).toBeNull();
    });

    /**
     * 감사 기록의 역할은 통과시킨 역할이다 — 02 §2.7.
     *
     * 바인딩을 하나 더 붙여 두 개로 만든다. `auditor`는 `project.create`를 하지
     * 못하므로 통과시키는 것은 `mpc_operator`뿐이다. 세션의 첫 바인딩을 적는
     * 구현이면 이 단언이 절반의 확률로 깨진다 —
     * `core.resolve_role_bindings`에 ORDER BY가 없어 순서가 계획에 달렸다.
     */
    it("행위를 허용한 역할을 남긴다 — 세션의 첫 역할이 아니다", async () => {
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (gen_random_uuid(), ${fx.tenantA}, ${fx.operatorSubjectA}, ${fx.orgA}, 'auditor')
      `;

      try {
        const token = await signIn(app, fx.operatorA);
        const created = (await create(token, body())).json();

        const [audit] = await fx.sql<{ effective_role: string }[]>`
          SELECT effective_role FROM audit.events WHERE resource_id = ${created.id}
        `;
        expect(audit!.effective_role).toBe("mpc_operator");
      } finally {
        await fx.sql`
          DELETE FROM core.role_bindings
          WHERE subject_id = ${fx.operatorSubjectA} AND role = 'auditor'
        `;
      }
    });

    it("outbox payload에 개인정보를 넣지 않는다", async () => {
      const response = await create(tokens.operatorA, body());
      const created = response.json();
      const [event] = await fx.sql<{ payload: Record<string, unknown> }[]>`
        SELECT payload FROM core.outbox WHERE aggregate_id = ${created.id}
      `;
      const serialized = JSON.stringify(event!.payload);
      expect(serialized).not.toContain(fx.operatorA.address);
      expect(serialized).not.toMatch(/@/);
    });
  });

  describe("인증·권한", () => {
    it("인증 없이 등록할 수 없다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { "idempotency-key": idempotencyKey() },
        payload: body(),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("UNAUTHENTICATED");
    });

    it("미등록 wallet은 403 WALLET_NOT_ENROLLED다 — 로그인은 됐고 tenant가 없다", async () => {
      // 401이면 "다시 로그인하라"로 읽힌다. 서명은 이미 됐으므로 사실과 다르다.
      const response = await create(tokens.unknownWallet, body());
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("WALLET_NOT_ENROLLED");
    });

    it("tenant 소속이지만 역할이 없으면 403과 필요 역할을 반환한다", async () => {
      const response = await create(tokens.readerA, body());
      expect(response.statusCode).toBe(403);

      const error = response.json();
      expect(error.code).toBe("AUTHORIZATION_DENIED");
      expect(error.details.reason).toBe("ROLE_ACTION_NOT_ALLOWED");
      expect(error.details.requiredRoles).toContain("mpc_operator");
      expect(error.details.accessRequestPath).toBeTruthy();
    });

    it("권한 거절은 행을 만들지 않는다", async () => {
      const payload = body({ projectKey: "DENIED-NO-ROW" });
      await create(tokens.readerA, payload);

      const rows = await fx.sql`
        SELECT id FROM core.projects WHERE project_key = 'DENIED-NO-ROW'
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("멱등성 (07 §7.1)", () => {
    it("Idempotency-Key가 없으면 400이다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${tokens.operatorA}` },
        payload: body(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("짧은 key를 거절한다", async () => {
      const response = await create(tokens.operatorA, body(), "short");
      expect(response.statusCode).toBe(400);
    });

    it("같은 key + 같은 요청은 같은 결과를 준다", async () => {
      const key = idempotencyKey();
      const payload = body();

      const first = await create(tokens.operatorA, payload, key);
      const second = await create(tokens.operatorA, payload, key);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(first.json().id);

      const rows = await fx.sql`
        SELECT id FROM core.projects WHERE project_key = ${payload.projectKey as string}
      `;
      expect(rows).toHaveLength(1);
    });

    it("같은 key + 다른 요청은 409다", async () => {
      const key = idempotencyKey();
      await create(tokens.operatorA, body(), key);
      const response = await create(tokens.operatorA, body(), key);

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("IDEMPOTENCY_KEY_REUSE");
    });

    it("멱등 재시도가 이벤트를 두 번 만들지 않는다", async () => {
      const key = idempotencyKey();
      const payload = body();
      const first = await create(tokens.operatorA, payload, key);
      await create(tokens.operatorA, payload, key);

      const events = await fx.sql`
        SELECT id FROM core.outbox WHERE aggregate_id = ${first.json().id}
      `;
      expect(events).toHaveLength(1);
    });
  });

  describe("요청 검증", () => {
    it("필수 필드가 없으면 400이다", async () => {
      const response = await create(tokens.operatorA, { name: "이름만" });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("REQUEST_INVALID");
    });

    it("잘못된 ISO3 코드를 거절한다", async () => {
      const response = await create(tokens.operatorA, body({ hostCountryIso3: "MONGOLIA" }));
      expect(response.statusCode).toBe(400);
    });
  });

  describe("tenant 격리", () => {
    it("다른 tenant의 프로젝트는 404다 — 존재 여부도 알려주지 않는다", async () => {
      const created = await create(tokens.operatorB, body({ ownerOrganizationId: fx.orgB }));
      expect(created.statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${created.json().id}`,
        headers: { authorization: `Bearer ${tokens.operatorA}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("NOT_FOUND");
    });

    it("목록에 자기 tenant의 프로젝트만 나온다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${tokens.operatorB}` },
      });
      expect(response.statusCode).toBe(200);

      const items = response.json().items as { id: string }[];
      const ids = items.map((item) => item.id);

      const rows = await withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) =>
        tx<{ id: string }[]>`SELECT id FROM core.projects`,
      );
      expect(new Set(ids)).toEqual(new Set(rows.map((row) => row.id)));
    });

    it("다른 tenant의 조직으로 등록할 수 없다", async () => {
      const response = await create(tokens.operatorA, body({ ownerOrganizationId: fx.orgB }));
      // RLS가 FK 대상 조직을 보이지 않게 하므로 삽입이 실패한다.
      expect(response.statusCode).toBeGreaterThanOrEqual(400);

      const rows = await fx.sql`
        SELECT id FROM core.projects
        WHERE tenant_id = ${fx.tenantA} AND owner_organization_id = ${fx.orgB}
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("응답 규약", () => {
    it("오류 응답이 envelope 형식이다", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
      const envelope = response.json();
      expect(envelope).toHaveProperty("code");
      expect(envelope).toHaveProperty("message");
      expect(envelope).toHaveProperty("retryable");
      expect(envelope).toHaveProperty("correlationId");
    });

    it("correlation ID를 헤더에서 이어받는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/does-not-exist",
        headers: { "x-correlation-id": "trace-from-client" },
      });
      expect(response.json().correlationId).toBe("trace-from-client");
      expect(response.headers["x-correlation-id"]).toBe("trace-from-client");
    });

    it("모든 응답에 X-Request-Id가 있다", async () => {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      expect(response.headers["x-request-id"]).toBeTruthy();
    });
  });
});
