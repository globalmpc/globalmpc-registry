import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createMetricsRegistry } from "../src/metrics.js";
import { setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 메트릭 — 06 §6.9.
 *
 * 이 파일이 확인하는 것의 절반은 **무엇을 담지 않는가**다. 메트릭은 보통 인증
 * 없이 수집되므로 담긴 것이 그대로 노출된다.
 */
describe("메트릭 레지스트리", () => {
  /**
   * 게이지.
   *
   * 프로세스가 세는 counter로는 **멈춘 worker**가 잡히지 않는다. 죽은 worker는
   * 아무것도 보고하지 않고 알림 규칙은 조용해진다.
   */
  it("게이지를 상태별로 낸다", () => {
    const metrics = createMetricsRegistry();
    metrics.setGauges([
      { metric: "anchor_transactions", label: "confirmed", value: 12 },
      { metric: "anchor_transactions", label: "failed", value: 2 },
      { metric: "outbox_pending", label: "all", value: 7 },
    ]);

    const output = metrics.render();
    expect(output).toContain('mpc_anchor_transactions{state="failed"} 2');
    expect(output).toContain('mpc_outbox_pending{state="all"} 7');
    // 같은 이름의 TYPE을 두 번 내면 Prometheus가 스크레이프 전체를 버린다.
    expect(output.match(/# TYPE mpc_anchor_transactions gauge/g)).toHaveLength(1);
  });

  it("게이지는 누적이 아니라 현재 상태다", () => {
    const metrics = createMetricsRegistry();
    metrics.setGauges([{ metric: "outbox_pending", label: "all", value: 7 }]);
    metrics.setGauges([{ metric: "outbox_pending", label: "all", value: 3 }]);

    expect(metrics.render()).toContain('mpc_outbox_pending{state="all"} 3');
    expect(metrics.render()).not.toContain('mpc_outbox_pending{state="all"} 7');
  });


  it("요청 수와 응답 시간을 센다", () => {
    const metrics = createMetricsRegistry();
    metrics.observeRequest("GET", "/api/v1/projects", 200, 12);
    metrics.observeRequest("GET", "/api/v1/projects", 200, 40);

    const output = metrics.render();
    expect(output).toContain('http_requests_total{method="GET",route="/api/v1/projects",status="2xx"} 2');
    expect(output).toContain("http_request_duration_ms_sum");
    expect(output).toContain("http_request_duration_ms_count");
  });

  it("상태 코드를 계열로 묶는다", () => {
    // 200과 201을 나눌 이유가 없고 시계열만 늘어난다.
    const metrics = createMetricsRegistry();
    metrics.observeRequest("POST", "/api/v1/projects", 200, 5);
    metrics.observeRequest("POST", "/api/v1/projects", 201, 5);

    expect(metrics.render()).toContain('status="2xx"} 2');
  });

  it("버킷이 누적으로 올라간다", () => {
    const metrics = createMetricsRegistry();
    metrics.observeRequest("GET", "/x", 200, 7);

    const output = metrics.render();
    // 7ms는 le=5에 안 들어가고 le=10부터 들어간다.
    expect(output).toContain('le="5"} 0');
    expect(output).toContain('le="10"} 1');
  });

  it("레이블 값의 따옴표를 이스케이프한다", () => {
    // 이스케이프하지 않으면 한 줄이 깨져 수집기가 파일 전체를 버린다.
    const metrics = createMetricsRegistry();
    metrics.incrementCounter("app_events_total", { name: 'we"ird' });
    expect(metrics.render()).toContain('name="we\\"ird"');
  });
});

describeDb("메트릭 endpoint", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  it("인증 없이 조회된다", async () => {
    // 인증을 거는 대신 담지 않는다. 수집기가 토큰을 들고 다니지 않아도 된다.
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("경로 파라미터가 시계열을 늘리지 않는다", async () => {
    const token = await signIn(app, fx.operatorA);
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;
    // UUID가 레이블에 들어가면 프로젝트마다 시계열이 생겨 수집기가 죽는다.
    expect(output).not.toContain(fx.projectA);
    expect(output).toContain('route="/api/v1/projects/:projectId"');
  });

  it("tenant를 레이블로 쓰지 않는다", async () => {
    const token = await signIn(app, fx.operatorA);
    await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}` },
    });

    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;
    // 메트릭이 무인증이므로 tenant 목록이 그대로 노출된다.
    expect(output).not.toContain(fx.tenantA);
  });

  it("자기 자신을 세지 않는다", async () => {
    await app.inject({ method: "GET", url: "/metrics" });
    await app.inject({ method: "GET", url: "/health/ready" });

    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;
    // 수집 주기가 곧 트래픽으로 보이면 실제 부하를 알 수 없다.
    expect(output).not.toContain('route="/metrics"');
    expect(output).not.toContain('route="/health/ready"');
  });
});
