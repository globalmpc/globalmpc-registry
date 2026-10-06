import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ROUTES,
  implementedRoutes,
  plannedRoutes,
  toFastifyPath,
} from "@mpc/api-contract";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Contract ↔ implementation parity.
 *
 * ADR-T05 said "runtime validation and docs come from one definition", but only schemas
 * are shared and **route registration is manual**, so the two can drift. They did —
 * `GET /api/v1/projects` was implemented without a contract.
 *
 * This file catches that drift in both directions.
 *
 * - route marked `implemented: true` in the contract but not registered → fail
 * - registered `/api/v1/**` route missing from the contract → fail
 *
 * Ops endpoints (`/health/*`) are not part of the API contract and are excluded.
 */

const API_PREFIX = "/api/v1";

function isApiRoute(url: string): boolean {
  return url.startsWith(API_PREFIX);
}

describeDb("contract ↔ implementation parity", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorA: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // From R1, auth is SIWE signature → session token. Tests take the same path.
    tokens = {
      operatorA: await signIn(app, fx.operatorA),
    };
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function registeredApiRoutes(): Set<string> {
    return new Set(
      app.registeredRoutes
        .filter((route) => isApiRoute(route.url))
        // HEAD, auto-registered by Fastify, is a by-product of GET and not compared.
        .filter((route) => route.method !== "HEAD")
        .map((route) => `${route.method} ${route.url}`),
    );
  }

  it("registers every route the contract marks as implemented", () => {
    const registered = registeredApiRoutes();
    const missing = implementedRoutes()
      .map((route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`)
      .filter((key) => !registered.has(key));

    expect(missing, "implemented in the contract but not registered on the server").toEqual([]);
  });

  it("every registered API route is in the contract", () => {
    const contracted = new Set(
      ROUTES.map((route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`),
    );
    const undocumented = [...registeredApiRoutes()].filter((key) => !contracted.has(key));

    expect(undocumented, "implemented but missing from the contract (ROUTES)").toEqual([]);
  });

  it("routes the contract marks as planned are not yet registered", () => {
    const registered = registeredApiRoutes();
    const unexpected = plannedRoutes()
      .map((route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`)
      .filter((key) => registered.has(key));

    expect(
      unexpected,
      "once implemented, set the contract's implemented flag to true",
    ).toEqual([]);
  });

  it("tallies remaining work per release", () => {
    const byRelease = new Map<string, string[]>();
    for (const route of plannedRoutes()) {
      const release = route.plannedRelease ?? "unassigned";
      byRelease.set(release, [...(byRelease.get(release) ?? []), route.operationId]);
    }

    // An unimplemented route must have a release. Without one it lives only in the
    // contract, and nobody knows when it will be built.
    // Zero planned is fine — it means every contract route is implemented.
    expect(byRelease.get("unassigned") ?? []).toEqual([]);
    expect(plannedRoutes().length).toBe([...byRelease.values()].flat().length);
  });

  it("implemented mutation routes actually require Idempotency-Key", async () => {
    const mutations = implementedRoutes().filter((route) => route.mutation);
    expect(mutations.length).toBeGreaterThan(0);

    for (const route of mutations) {
      const response = await app.inject({
        method: route.method.toUpperCase() as "POST",
        url: toFastifyPath(route.path).replace(/:[^/]+/g, "00000000-0000-0000-0000-000000000000"),
        headers: { authorization: `Bearer ${tokens.operatorA}` },
        payload: {},
      });
      // A missing key must yield 400 IDEMPOTENCY_KEY_REQUIRED. It must trip before body
      // validation for retries to be safe.
      expect(response.statusCode, route.operationId).toBe(400);
      expect(response.json().code, route.operationId).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });

  it("routes whose contract requires If-Match reject requests without it", async () => {
    const guarded = implementedRoutes().filter((route) => route.requiresIfMatch);
    // If this list is empty, the check does nothing. Since 07 §7.1 requires it,
    // there must be at least one.
    expect(guarded.length).toBeGreaterThan(0);

    for (const route of guarded) {
      const response = await app.inject({
        method: route.method.toUpperCase() as "POST",
        url: toFastifyPath(route.path).replace(/:[^/]+/g, "00000000-0000-0000-0000-000000000000"),
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": "if-match-parity-check-key",
        },
        payload: {},
      });

      // Must be 428. A 412 reads as "wrong version" and hides the fact that the
      // header is missing.
      expect(response.statusCode, route.operationId).toBe(428);
      expect(response.json().code, route.operationId).toBe("IF_MATCH_REQUIRED");
    }
  });

  it("mutations that do not require If-Match proceed without the header", async () => {
    // If the contract says false but the implementation requires it, clients cannot trust the contract.
    const unguarded = implementedRoutes().filter(
      (route) => route.mutation && !route.requiresIfMatch,
    );

    for (const route of unguarded) {
      const response = await app.inject({
        method: route.method.toUpperCase() as "POST",
        url: toFastifyPath(route.path).replace(/:[^/]+/g, "00000000-0000-0000-0000-000000000000"),
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": "if-match-parity-check-key",
        },
        payload: {},
      });
      expect(response.statusCode, route.operationId).not.toBe(428);
    }
  });

  it("public routes are not 404 without authentication", async () => {
    const publicImplemented = implementedRoutes().filter(
      (route) => route.public && route.method === "post",
    );

    for (const route of publicImplemented) {
      const response = await app.inject({
        method: "POST",
        url: route.path,
        payload: {},
      });
      // A 400 for an empty body is fine. A 404 means the route is missing.
      expect(response.statusCode, route.operationId).not.toBe(404);
    }
  });
});
