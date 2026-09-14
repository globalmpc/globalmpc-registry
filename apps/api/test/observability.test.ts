import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Observability routes — 02 §2.6, 07 §7.5.
 *
 * What is checked here is not "lookup works" but **what is not exported**.
 * If the audit view becomes a channel for sensitive data, the append-only guarantee is moot.
 */
describeDb("observability", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);

    // Performs one action that leaves an audit record.
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

  it("reads audit records", async () => {
    const response = await audit(operatorToken);
    expect(response.statusCode).toBe(200);
    expect(response.json().items.length).toBeGreaterThan(0);
  });

  it("does not export detail", async () => {
    const response = await audit(operatorToken);
    const [event] = response.json().items as Record<string, unknown>[];

    // Event payloads are meant to exclude PII, but if that promise breaks, this view would be
    // the first leak path. So the channel is never built.
    expect(event).not.toHaveProperty("detail");
    expect(event).toHaveProperty("command");
    expect(event).toHaveProperty("correlationId");
  });

  it("rejects without audit.read", async () => {
    // Who did what is not for everyone to see.
    const response = await audit(stewardToken);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("auditor");
  });

  it("filters by resource type", async () => {
    const response = await audit(operatorToken, "?resourceType=claim");
    expect(response.statusCode).toBe(200);
    for (const event of response.json().items as { resourceType: string }[]) {
      expect(event.resourceType).toBe("claim");
    }
  });

  it("records of another tenant are not visible", async () => {
    const otherToken = await signIn(app, fx.operatorB);
    const response = await audit(otherToken, `?projectId=${fx.projectA}`);

    // An empty list, not a permission error. For another tenant, this project does not exist.
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("outbox backlog reports lag in seconds", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/outbox-backlog",
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Lag matters more than count. 1000 items 1 second late and 1 item an hour late are
    // different problems.
    expect(body).toHaveProperty("oldestPendingAgeSeconds");
    expect(body).toHaveProperty("byEventType");
    expect(typeof body.pending).toBe("number");
  });

  it("backlog lookup also requires permission", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/outbox-backlog",
      headers: { authorization: `Bearer ${stewardToken}` },
    });
    expect(response.statusCode).toBe(403);
  });

  /**
   * Checks that time caps are applied **on the actual server instance**.
   *
   * Having a value in config differs from Fastify passing it to the Node server.
   * This is where a measurement found 0.
   */
  it("server has total request time and socket idle caps applied", () => {
    expect(app.server.requestTimeout).toBeGreaterThan(0);
    expect(app.server.timeout).toBeGreaterThan(0);
    // headersTimeout is meaningless if larger than requestTimeout — the request is cut off
    // before the headers finish arriving.
    expect(app.server.headersTimeout).toBeLessThanOrEqual(app.server.requestTimeout);
  });

  /**
   * Whether `/metrics` actually carries DB gauges.
   *
   * A registry being able to draw a gauge differs from the route filling it. This is where
   * a measurement found "exposed, but nothing to collect".
   */
  it("/metrics carries gauges read from the DB", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("mpc_outbox_pending");
    expect(response.body).toContain("mpc_uploads_quarantined");
    // On lookup failure this counter increments instead of failing the scrape.
    expect(response.body).not.toContain("mpc_gauge_scrape_failed_total");
  });

  it("metrics carry no tenant", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });

    // Metrics are scraped without auth. Whatever they contain is exposed as is.
    expect(response.body).not.toContain(fx.tenantA);
  });
});
