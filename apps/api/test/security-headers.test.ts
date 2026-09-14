import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { testEnv } from "./helpers/db.js";
import { securityHeaders } from "../src/plugins/security-headers.js";

/**
 * The API returns only JSON. So the CSP on this surface is a full block, not an
 * allowlist — 10 §10.6.
 */
describe("security header values", () => {
  it("loads no resources", () => {
    const headers = securityHeaders({ production: false });
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("base-uri 'none'");
  });

  it("blocks MIME sniffing and framing", () => {
    const headers = securityHeaders({ production: false });
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  it("blocks referrer and browser features by default", () => {
    const headers = securityHeaders({ production: false });
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toContain("geolocation=()");
  });

  /**
   * Local is http. A browser that gets HSTS there forces https for that host,
   * locking out other local projects on the same host name.
   */
  it("sends HSTS only in production", () => {
    expect(securityHeaders({ production: false })["strict-transport-security"]).toBeUndefined();
    const prod = securityHeaders({ production: true })["strict-transport-security"];
    expect(prod).toContain("max-age=");
    expect(prod).toContain("includeSubDomains");
  });
});

/**
 * Correct values are not enough. A running server checks that the hook is attached and
 * that headers go out **on non-success responses too**. Missing headers on error and
 * over-cap responses are a common gap, and that is where reflected values are most likely.
 *
 * No DB. Headers run before route handling, so fake SQL is enough.
 */
describe("security headers are on every response", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const fakeSql = (async () => []) as unknown as postgres.Sql;
    app = await buildServer(
      loadConfig(testEnv({ DATABASE_URL: "postgres://unused", RATE_LIMIT_MAX: "2" })),
      fakeSql,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("on 404 responses", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("on authentication failure responses", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("on over-cap responses", async () => {
    let last = await app.inject({ method: "GET", url: "/api/v1/projects" });
    for (let i = 0; i < 4 && last.statusCode !== 429; i += 1) {
      last = await app.inject({ method: "GET", url: "/api/v1/projects" });
    }
    expect(last.statusCode).toBe(429);
    expect(last.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
