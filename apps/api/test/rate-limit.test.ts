import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * This group runs without a DB. It checks, in real hook order, that the cap runs before the DB.
 * The fake SQL only counts calls, so a 429 request that reaches session lookup shows at once.
 */
describe("pre-validation request cap", () => {
  let app: FastifyInstance;
  let sqlCalls: number;

  beforeAll(async () => {
    sqlCalls = 0;
    const fakeSql = (async () => {
      sqlCalls += 1;
      return [];
    }) as unknown as postgres.Sql;

    app = await buildServer(
      loadConfig(
        testEnv({
          DATABASE_URL: "postgres://unused",
          RATE_LIMIT_MAX: "2",
          AUTH_RATE_LIMIT_MAX: "2",
        }),
      ),
      fakeSql,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("rotating fake Bearers gets no new quota, and a 429 does not read the session DB", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: {
          authorization: `Bearer different-invalid-token-${attempt}`,
          "x-forwarded-for": "203.0.113.20",
        },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429, 429]);
    // Only the two allowed requests call resolve_session_token.
    expect(sqlCalls).toBe(2);
  });

  it("SIWE ignores the Bearer header and applies a narrow per-IP cap", async () => {
    const callsBefore = sqlCalls;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        headers: {
          authorization: `Bearer different-invalid-token-${attempt}`,
          "x-forwarded-for": "203.0.113.21",
        },
        payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429, 429]);
    // SIWE routes skip session lookup and run only the allowed nonce INSERTs.
    expect(sqlCalls - callsBefore).toBe(2);
  });
});

/**
 * Request cap — 06 §6.9.
 *
 * The contract states that unauthenticated paths have a separate cap. Other tests run
 * with a generous cap, so whether the cap actually trips is checked **only here**.
 */
describeDb("request cap", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(
      loadConfig(testEnv({ RATE_LIMIT_MAX: "50", AUTH_RATE_LIMIT_MAX: "3" })),
      fx.appSql,
    );
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function nonce() {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/siwe/nonce",
      payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
    });
  }

  it("sign-in paths have a narrow cap", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await nonce()).statusCode);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it("keeps the envelope format when capped — the UI knows what to do next", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) await nonce();

    const response = await nonce();
    expect(response.statusCode).toBe(429);

    const body = response.json() as {
      code: string;
      retryable: boolean;
      correlationId: string;
      details?: { retryAfterSeconds?: string };
    };
    expect(body.code).toBe("RATE_LIMITED");
    // The cap lifts over time. Marking it non-retryable makes users give up.
    expect(body.retryable).toBe(true);
    expect(body.correlationId).not.toBe("unknown");
    expect(body.details?.retryAfterSeconds).toBeDefined();
  });

  it("ops endpoints are exempt — scrape intervals do not consume the cap", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      statuses.push((await app.inject({ method: "GET", url: "/health/live" })).statusCode);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
  });
});

/**
 * Request cap behind a proxy — 06 §6.9.
 *
 * In deployment the API is reached only through the `web` `/api/*` proxy (`apps/web/src/proxy.ts`).
 * So the socket address the API sees is **the one web container for every request**. If the
 * cap key falls to that address, the unauthenticated-path cap (SIWE nonce/verify) becomes
 * site-wide, and one person using 10 requests blocks everyone's sign-in for that minute.
 *
 * So the requester is found by **counting trusted hops from the right of `x-forwarded-for`**.
 * The left side is requester-controlled, so it is not counted.
 */
describeDb("request cap behind a proxy", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(
      loadConfig(testEnv({ RATE_LIMIT_MAX: "50", AUTH_RATE_LIMIT_MAX: "2" })),
      fx.appSql,
    );
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function nonce(forwardedFor: string | undefined) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/siwe/nonce",
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
      payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
    });
  }

  it("counts the cap per requester — one person cannot block all sign-ins", async () => {
    const first: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      first.push((await nonce("203.0.113.10")).statusCode);
    }
    expect(first).toEqual([200, 200, 429]);

    // Even after the first requester uses up their quota, others still get theirs.
    expect((await nonce("203.0.113.11")).statusCode).toBe(200);
  });

  it("prepending values to the header gets no new quota — the cap cannot be bypassed", async () => {
    expect((await nonce("198.51.100.7")).statusCode).toBe(200);
    expect((await nonce("198.51.100.7")).statusCode).toBe(200);
    expect((await nonce("198.51.100.7")).statusCode).toBe(429);

    // If the untrusted left entries change but the right side is the same, the quota is the same.
    expect((await nonce("9.9.9.9, 198.51.100.7")).statusCode).toBe(429);
    expect((await nonce("1.1.1.1, 2.2.2.2, 198.51.100.7")).statusCode).toBe(429);
  });
});

/**
 * Makes the server report a wrong hop count by itself.
 *
 * If `TRUSTED_PROXY_HOPS` is below the real proxy count, the requester resolves to the
 * container's private address — the cap becomes site-wide. This state returns 200 with
 * no error, so nobody gets a signal. So a warning is logged the first time the cap key
 * falls to a private address.
 */
describeDb("requester address warning", () => {
  let fx: TestFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.close();
  });

  async function warningsFor(forwardedFor: string | undefined): Promise<string> {
    const app = await buildServer(loadConfig(testEnv()), fx.appSql);
    const collected: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => {
      collected.push(args);
    }) as typeof app.log.warn;

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/siwe/nonce",
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
      payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
    });
    await app.close();

    return JSON.stringify(collected);
  }

  it("names what is misconfigured when the requester resolves to a private address", async () => {
    expect(await warningsFor(undefined)).toMatch(/TRUSTED_PROXY_HOPS/);
  });

  it("stays silent for a public address — no noise in a correct deployment", async () => {
    expect(await warningsFor("203.0.113.7")).not.toMatch(/TRUSTED_PROXY_HOPS/);
  });
});
