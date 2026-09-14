import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 관측 route — 02 §2.6, 07 §7.5.
 *
 * 여기서 확인하는 것은 "조회가 된다"가 아니라 **무엇을 내보내지 않는가**다.
 * 감사 화면이 민감 정보의 통로가 되면 append-only 보장의 의미가 없어진다.
 */
describeDb("관측", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);

    // 감사 기록이 남는 행위를 하나 만든다.
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        claimType: "mining_right_registration",
        valueText: "MV-999999",
        sourceCoordinate: { document: "extract", page: "1" },
        evidenceTier: "P1",
        verificationState: "analyst_checked",
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function audit(token: string, query = "") {
    return app.inject({
      method: "GET",
      url: `/api/v1/audit-events${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("감사 기록을 조회한다", async () => {
    const response = await audit(operatorToken);
    expect(response.statusCode).toBe(200);
    expect(response.json().items.length).toBeGreaterThan(0);
  });

  it("detail을 내보내지 않는다", async () => {
    const response = await audit(operatorToken);
    const [event] = response.json().items as Record<string, unknown>[];

    // 이벤트 payload에 PII를 넣지 않기로 했지만, 약속이 깨졌을 때 이 화면이
    // 최초 유출 경로가 된다. 애초에 통로를 만들지 않는다.
    expect(event).not.toHaveProperty("detail");
    expect(event).toHaveProperty("command");
    expect(event).toHaveProperty("correlationId");
  });

  it("audit.read 권한이 없으면 거절한다", async () => {
    // 누가 무엇을 했는지는 아무나 볼 것이 아니다.
    const response = await audit(stewardToken);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("auditor");
  });

  it("resource 유형으로 좁힐 수 있다", async () => {
    const response = await audit(operatorToken, "?resourceType=claim");
    expect(response.statusCode).toBe(200);
    for (const event of response.json().items as { resourceType: string }[]) {
      expect(event.resourceType).toBe("claim");
    }
  });

  it("다른 tenant의 기록은 보이지 않는다", async () => {
    const otherToken = await signIn(app, fx.operatorB);
    const response = await audit(otherToken, `?projectId=${fx.projectA}`);

    // 권한 오류가 아니라 빈 목록이다. 다른 tenant에게 이 프로젝트는 없다.
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("outbox backlog가 지연을 초 단위로 알려준다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/outbox-backlog",
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // 건수보다 지연 시간이 중요하다. 1000건이 1초 늦는 것과 1건이 한 시간 늦는
    // 것은 다른 문제다.
    expect(body).toHaveProperty("oldestPendingAgeSeconds");
    expect(body).toHaveProperty("byEventType");
    expect(typeof body.pending).toBe("number");
  });

  it("backlog 조회에도 권한이 필요하다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/outbox-backlog",
      headers: { authorization: `Bearer ${stewardToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  /**
   * 시간 상한이 **실제 서버 인스턴스에** 걸렸는지 본다.
   *
   * 설정에 값이 있는 것과 Fastify가 그것을 Node 서버에 넘기는 것은 다르다.
   * 실측으로 0을 발견한 자리가 여기다.
   */
  it("요청 총시간과 소켓 유휴 상한이 서버에 걸려 있다", () => {
    expect(app.server.requestTimeout).toBeGreaterThan(0);
    expect(app.server.timeout).toBeGreaterThan(0);
    // headersTimeout은 requestTimeout보다 크면 의미가 없다 — 헤더를 다 받기
    // 전에 요청이 먼저 끊긴다.
    expect(app.server.headersTimeout).toBeLessThanOrEqual(app.server.requestTimeout);
  });

  /**
   * `/metrics`가 DB 게이지를 실제로 담는지.
   *
   * 레지스트리가 게이지를 그릴 수 있다는 것과 route가 그것을 채운다는 것은
   * 다르다. 실측으로 "노출은 있는데 수집할 값이 없다"를 발견한 자리가 여기다.
   */
  it("/metrics가 DB에서 읽은 게이지를 담는다", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("mpc_outbox_pending");
    expect(response.body).toContain("mpc_uploads_quarantined");
    // 조회가 실패하면 스크레이프를 죽이는 대신 이 counter가 오른다.
    expect(response.body).not.toContain("mpc_gauge_scrape_failed_total");
  });

  it("메트릭에 tenant를 담지 않는다", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    // 메트릭은 인증 없이 수집된다. 담긴 것은 그대로 노출된다.
    expect(response.body).not.toContain(fx.tenantA);
  });
});
