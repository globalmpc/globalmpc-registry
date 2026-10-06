import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Load behavior — spec 06 §6.9.
 *
 * This is not a performance benchmark. Absolute numbers vary by machine and do not
 * reproduce in CI. It checks that **invariants hold under concurrency**.
 *
 * - concurrent requests with the same Idempotency-Key apply only once
 * - concurrent mutations do not skip or overwrite versions
 * - RLS does not mix tenants under load
 * - pool exhaustion does not silently turn errors into success
 *
 * None of these show up in sequential runs, hence a separate file.
 */
describeDb("invariants under concurrency", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let stewardToken: string;
  let operatorBToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);
    operatorBToken = await signIn(app, fx.operatorB);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function createProject(token: string, key: string, idem: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idem },
      payload: {
        projectKey: key,
        name: "load check",
        hostCountryIso3: "MNG",
        minerals: ["copper"],
        ownerOrganizationId: fx.orgA,
      },
    });
  }

  it("creates only one resource for concurrent requests with the same Idempotency-Key", async () => {
    const key = `LOAD-IDEM-${Date.now()}`;
    const idem = idempotencyKey();

    // Network retries arrive concurrently, not in sequence. Sequential tests miss this.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => createProject(operatorToken, key, idem)),
    );

    const created = responses.filter((response) => response.statusCode === 200);
    expect(created.length).toBeGreaterThan(0);

    // All successes must point to the same project.
    const ids = new Set(created.map((response) => response.json().id));
    expect(ids.size).toBe(1);

    const rows = await fx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM core.projects WHERE project_key = ${key}
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("different keys each create a resource even when concurrent", async () => {
    const stamp = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createProject(operatorToken, `LOAD-MANY-${stamp}-${index}`, idempotencyKey()),
      ),
    );

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.json().id)).size).toBe(10);
  });

  it("concurrent conflict writes do not skip versions", async () => {
    const claim = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/claims`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          claimType: "mining_right_registration",
          valueText: `LOAD-${Date.now()}`,
          sourceCoordinate: { document: "extract", page: "1" },
          evidenceTier: "P1",
          verificationState: "analyst_checked",
        },
      })
    ).json();

    // 10 writers who saw the same version write concurrently.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: `/api/v1/claims/${claim.id}/conflicts`,
          headers: {
            authorization: `Bearer ${stewardToken}`,
            "idempotency-key": idempotencyKey(),
            "if-match": `"${claim.version}"`,
          },
          payload: { conflictType: "estimate_conflict" },
        }),
      ),
    );

    const succeeded = responses.filter((response) => response.statusCode === 200);
    // Without If-Match all 10 pass and 9 judgments are lost.
    expect(succeeded).toHaveLength(1);

    const [row] = await fx.sql<{ version: number }[]>`
      SELECT version FROM core.claims WHERE id = ${claim.id}
    `;
    expect(row!.version).toBe(claim.version + 1);
  });

  it("tenants do not mix under concurrent load", async () => {
    const stamp = Date.now();

    // Two tenants alternate requests. They share the pool, so a leaking session variable
    // shows up here.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? createProject(operatorToken, `LOAD-A-${stamp}-${index}`, idempotencyKey())
          : app.inject({
              method: "POST",
              url: "/api/v1/projects",
              headers: {
                authorization: `Bearer ${operatorBToken}`,
                "idempotency-key": idempotencyKey(),
              },
              payload: {
                projectKey: `LOAD-B-${stamp}-${index}`,
                name: "tenant B",
                hostCountryIso3: "MNG",
                minerals: ["gold"],
                ownerOrganizationId: fx.orgB,
              },
            }),
      ),
    );

    const listA = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    const keys = (listA.json().items as { projectKey: string }[]).map((item) => item.projectKey);
    // Even one mixed row means RLS broke under load.
    expect(keys.filter((key) => key.startsWith(`LOAD-B-${stamp}`))).toEqual([]);
  });

  it("handles concurrent reads without errors", async () => {
    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        app.inject({
          method: "GET",
          url: "/api/v1/projects",
          headers: { authorization: `Bearer ${operatorToken}` },
        }),
      ),
    );

    // If the pool runs short, it must wait or return 503. A silently empty list is
    // indistinguishable from no data.
    for (const response of responses) {
      expect([200, 503]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        expect(Array.isArray(response.json().items)).toBe(true);
      }
    }
  });

  it("concurrent requests get distinct requestIds", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: "GET",
          url: "/api/v1/projects",
          headers: { authorization: `Bearer ${operatorToken}` },
        }),
      ),
    );

    // Duplicate values make tracing meaningless — requests cannot be told apart in logs.
    const ids = responses.map((response) => response.headers["x-request-id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
