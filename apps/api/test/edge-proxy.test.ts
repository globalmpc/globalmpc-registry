import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { testEnv } from "./helpers/db.js";

/**
 * The edge proxy path, checked in real hook order and without a DB.
 *
 * Three things a deployment behind a CDN relies on: the cap keys on the vouched visitor
 * address, the ops endpoints answer only peers on the container network, and the streaming
 * upload route admits exactly one cross-origin caller.
 */
const SECRET = "e".repeat(32);
const WEB_ORIGIN = "https://registry.example";

function fakeSql(): postgres.Sql {
  return (async () => []) as unknown as postgres.Sql;
}

async function server(env: Record<string, string>): Promise<FastifyInstance> {
  return buildServer(
    loadConfig(testEnv({ DATABASE_URL: "postgres://unused", RATE_LIMIT_MAX: "2", ...env })),
    fakeSql(),
  );
}

async function statusesFor(
  app: FastifyInstance,
  headersFor: (attempt: number) => Record<string, string>,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: headersFor(attempt),
    });
    statuses.push(response.statusCode);
  }
  return statuses;
}

describe("edge proxy path — requester address", () => {
  let open: FastifyInstance;
  let closed: FastifyInstance;

  beforeAll(async () => {
    open = await server({ EDGE_PROXY_SECRET: SECRET });
    closed = await server({});
  });

  afterAll(async () => {
    await open.close();
    await closed.close();
  });

  it("keys the cap on the vouched address when the secret matches", async () => {
    // Four visitors, one request each — none reaches the cap of two.
    expect(
      await statusesFor(open, (attempt) => ({
        "x-mpc-edge-secret": SECRET,
        "x-mpc-client-ip": `203.0.113.${attempt + 1}`,
      })),
    ).toEqual([200, 200, 200, 200]);
  });

  it("shares one key when the secret is wrong — the header alone buys nothing", async () => {
    expect(
      await statusesFor(open, (attempt) => ({
        "x-mpc-edge-secret": "w".repeat(32),
        "x-mpc-client-ip": `203.0.113.${attempt + 10}`,
      })),
    ).toEqual([200, 200, 429, 429]);
  });

  it("ignores the headers entirely when the path is closed", async () => {
    expect(
      await statusesFor(closed, (attempt) => ({
        "x-mpc-edge-secret": SECRET,
        "x-mpc-client-ip": `203.0.113.${attempt + 20}`,
      })),
    ).toEqual([200, 200, 429, 429]);
  });
});

describe("ops endpoints — peer ranges", () => {
  let app: FastifyInstance;
  let nobody: FastifyInstance;

  beforeAll(async () => {
    app = await server({});
    // An empty string reads as "not given" and takes the default; a list with no valid range is the closed form.
    nobody = await server({ OPS_ENDPOINT_CIDRS: "none" });
  });

  afterAll(async () => {
    await app.close();
    await nobody.close();
  });

  it("answers a peer on the container network", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live", remoteAddress: "127.0.0.1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
  });

  it("gives a public peer the same 404 as an unknown path", async () => {
    for (const url of ["/health/live", "/health/ready", "/metrics"]) {
      const response = await app.inject({ method: "GET", url, remoteAddress: "203.0.113.9" });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().code, url).toBe("NOT_FOUND");
    }
  });

  it("does not judge by a forwarded header — only the socket peer counts", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "127.0.0.1", "x-mpc-client-ip": "127.0.0.1" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a proxied request even when the proxy sits on a private range", async () => {
    for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
      const response = await app.inject({
        method: "GET",
        url: "/metrics",
        remoteAddress: "10.0.0.5",
        headers: { [header]: header === "forwarded" ? "for=198.51.100.7" : "198.51.100.7" },
      });
      expect(response.statusCode, header).toBe(404);
    }
  });

  it("admits nobody when the list names no valid range", async () => {
    const response = await nobody.inject({ method: "GET", url: "/health/live", remoteAddress: "127.0.0.1" });
    expect(response.statusCode).toBe(404);
  });
});

describe("streaming upload route — cross-origin access", () => {
  const STREAM = "/api/v1/projects/00000000-0000-0000-0000-000000000000/uploads/stream";
  let app: FastifyInstance;
  let closed: FastifyInstance;

  beforeAll(async () => {
    app = await server({ EDGE_WEB_ORIGIN: WEB_ORIGIN });
    closed = await server({});
  });

  afterAll(async () => {
    await app.close();
    await closed.close();
  });

  it("answers the preflight for the named origin on that route", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: STREAM,
      headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(response.headers["access-control-allow-methods"]).toBe("POST");
    expect(response.headers["access-control-allow-headers"]).toContain("idempotency-key");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("marks the actual response too, including an error envelope", async () => {
    // No session — the route answers 401, and the browser must still be allowed to read it.
    const response = await app.inject({ method: "POST", url: STREAM, headers: { origin: WEB_ORIGIN } });
    expect(response.statusCode).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
  });

  it("admits no other origin, no other route, and nothing when unset", async () => {
    const other = await app.inject({
      method: "OPTIONS",
      url: STREAM,
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(other.statusCode).toBe(404);
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();

    const elsewhere = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/projects",
      headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.headers["access-control-allow-origin"]).toBeUndefined();

    const unset = await closed.inject({
      method: "OPTIONS",
      url: STREAM,
      headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(unset.statusCode).toBe(404);
    expect(unset.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
