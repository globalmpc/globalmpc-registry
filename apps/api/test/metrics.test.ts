import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createMetricsRegistry } from "../src/metrics.js";
import { setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Metrics — 06 §6.9.
 *
 * Half of what this file checks is **what is left out**. Metrics are usually scraped
 * without auth, so whatever they contain is exposed.
 */
describe("metrics registry", () => {
  /**
   * Gauges.
   *
   * In-process counters do not catch **a stalled worker**. A dead worker reports
   * nothing, and alert rules go quiet.
   */
  it("emits gauges per state", () => {
    const metrics = createMetricsRegistry();
    metrics.setGauges([
      { metric: "anchor_transactions", label: "confirmed", value: 12 },
      { metric: "anchor_transactions", label: "failed", value: 2 },
      { metric: "outbox_pending", label: "all", value: 7 },
    ]);

    const output = metrics.render();
    expect(output).toContain('mpc_anchor_transactions{state="failed"} 2');
    expect(output).toContain('mpc_outbox_pending{state="all"} 7');
    // Emitting TYPE twice for one name makes Prometheus drop the whole scrape.
    expect(output.match(/# TYPE mpc_anchor_transactions gauge/g)).toHaveLength(1);
  });

  it("a gauge is current state, not cumulative", () => {
    const metrics = createMetricsRegistry();
    metrics.setGauges([{ metric: "outbox_pending", label: "all", value: 7 }]);
    metrics.setGauges([{ metric: "outbox_pending", label: "all", value: 3 }]);

    expect(metrics.render()).toContain('mpc_outbox_pending{state="all"} 3');
    expect(metrics.render()).not.toContain('mpc_outbox_pending{state="all"} 7');
  });


  it("counts requests and response time", () => {
    const metrics = createMetricsRegistry();
    metrics.observeRequest("GET", "/api/v1/projects", 200, 12);
    metrics.observeRequest("GET", "/api/v1/projects", 200, 40);

    const output = metrics.render();
    expect(output).toContain('http_requests_total{method="GET",route="/api/v1/projects",status="2xx"} 2');
    expect(output).toContain("http_request_duration_ms_sum");
    expect(output).toContain("http_request_duration_ms_count");
  });

  it("groups status codes by class", () => {
    // There is no reason to split 200 and 201; it only adds series.
    const metrics = createMetricsRegistry();
    metrics.observeRequest("POST", "/api/v1/projects", 200, 5);
    metrics.observeRequest("POST", "/api/v1/projects", 201, 5);

    expect(metrics.render()).toContain('status="2xx"} 2');
  });

  it("buckets are cumulative", () => {
    const metrics = createMetricsRegistry();
    metrics.observeRequest("GET", "/x", 200, 7);

    const output = metrics.render();
    // 7ms is not in le=5; it counts from le=10 up.
    expect(output).toContain('le="5"} 0');
    expect(output).toContain('le="10"} 1');
  });

  it("escapes quotes in label values", () => {
    // Unescaped, one broken line makes the scraper drop the whole file.
    const metrics = createMetricsRegistry();
    metrics.incrementCounter("app_events_total", { name: 'we"ird' });
    expect(metrics.render()).toContain('name="we\\"ird"');
  });
});

describeDb("metrics endpoint", () => {
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

  it("is readable without authentication", async () => {
    // Instead of requiring auth, it omits sensitive data. The scraper needs no token.
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("path parameters do not add series", async () => {
    const token = await signIn(app, fx.operatorA);
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;
    // A UUID in a label creates a series per project and kills the scraper.
    expect(output).not.toContain(fx.projectA);
    expect(output).toContain('route="/api/v1/projects/:projectId"');
  });

  it("does not use tenant as a label", async () => {
    const token = await signIn(app, fx.operatorA);
    await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}` },
    });

    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;
    // Metrics are unauthenticated, so the tenant list would be exposed.
    expect(output).not.toContain(fx.tenantA);
  });

  it("does not count itself", async () => {
    await app.inject({ method: "GET", url: "/metrics" });
    await app.inject({ method: "GET", url: "/health/ready" });

    const output = (await app.inject({ method: "GET", url: "/metrics" })).body;
    // If scrapes show up as traffic, real load cannot be read.
    expect(output).not.toContain('route="/metrics"');
    expect(output).not.toContain('route="/health/ready"');
  });
});
