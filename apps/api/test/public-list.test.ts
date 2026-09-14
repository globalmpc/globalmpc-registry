import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PUBLIC_FIELD_ALLOWLIST } from "@mpc/domain";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Public list and search.
 *
 * The public lookup from 0009 requires already knowing `(registryType, publicKey)`, so
 * there was no way to ask what exists. This file verifies not "a list comes back" but
 * **that no boundary leaks while the list scans**.
 */
describeDb("public Registry list and search", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;
  /** publicKey of entries this file creates. Prefixed to avoid mixing with other files' records. */
  const prefix = `LIST-${randomUUID().slice(0, 8)}`;

  function projection(overrides: Record<string, unknown> = {}) {
    return {
      stableId: randomUUID(),
      status: "registered",
      version: "1",
      asOf: "2026-08-01T00:00:00.000Z",
      sourceAge: "12",
      staleStatus: "fresh",
      limitations: ["Legal title verification is outside this review's scope"],
      legalEffect: "none",
      disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
      ...overrides,
    };
  }

  async function publish(publicKey: string, overrides: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey,
        projection: projection(overrides),
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function list(search: string) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/public/registries/project${search}`,
    });
    return { status: response.statusCode, body: response.json() };
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA);

    // Pagination needs a deterministic order. Publishes run serially.
    await publish(`${prefix}-A`, { projectName: "Altan Ridge", hostCountry: "MN" });
    await publish(`${prefix}-B`, { projectName: "Khuren Valley", mineral: ["copper", "gold"] });
    await publish(`${prefix}-C`, { projectName: "Nomin Hill", hostCountry: "MN" });
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function ours(items: { publicKey: string }[]) {
    return items.filter((item) => item.publicKey.startsWith(prefix));
  }

  it("lists without an identifier", async () => {
    const { status, body } = await list("?limit=100");

    expect(status).toBe(200);
    expect(ours(body.items).map((item) => item.publicKey).sort()).toEqual([
      `${prefix}-A`,
      `${prefix}-B`,
      `${prefix}-C`,
    ]);
  });

  it("is readable without signing in", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/registries/project?limit=1",
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * The core of this file. The list scans many entries across tenants, so one leaking
   * row leaks everything.
   */
  it("returns no fields outside the public allowlist", async () => {
    const { body } = await list("?limit=100");

    for (const item of body.items) {
      const leaked = Object.keys(item.projection).filter(
        (field) => !(PUBLIC_FIELD_ALLOWLIST as readonly string[]).includes(field),
      );
      expect(leaked).toEqual([]);
    }
  });

  it("does not reveal the tenant", async () => {
    const { body } = await list("?limit=100");

    expect(JSON.stringify(body)).not.toContain(fx.tenantA);
    for (const item of body.items) {
      expect(Object.keys(item)).not.toContain("tenantId");
    }
  });

  it("states the sort order in the response and does not let the client choose it", async () => {
    const { body } = await list("?limit=100");

    expect(body.sort).toBe("publishedAt:desc,entryId:desc");

    const rejected = await list("?limit=100&sort=projectName:asc");
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("INVALID_QUERY");
  });

  it("does not repeat a row when paging with cursor", async () => {
    const first = await list("?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTypeOf("string");

    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    const firstKeys = first.body.items.map((item: { publicKey: string }) => item.publicKey);
    const secondKeys = second.body.items.map((item: { publicKey: string }) => item.publicKey);

    expect(secondKeys.some((key: string) => firstKeys.includes(key))).toBe(false);
  });

  it("the last page has a null nextCursor", async () => {
    const { body } = await list("?limit=100");

    expect(body.nextCursor).toBeNull();
  });

  it("does not silently fall back to page one on a tampered cursor", async () => {
    const { status, body } = await list("?cursor=not-a-real-cursor");

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_CURSOR");
  });

  it("searches by projectName, hostCountry, mineral and publicKey", async () => {
    for (const [term, expected] of [
      ["Khuren", `${prefix}-B`],
      ["copper", `${prefix}-B`],
      ["Nomin Hill", `${prefix}-C`],
      [`${prefix}-A`, `${prefix}-A`],
    ] as const) {
      const { body } = await list(`?limit=100&q=${encodeURIComponent(term)}`);
      expect(ours(body.items).map((item) => item.publicKey)).toContain(expected);
    }
  });

  /**
   * `%` is a search term, not a wildcard. Unescaped, a single `%` returns
   * everything — a filter bypass, not a search.
   */
  it("treats LIKE wildcards in the query as literals", async () => {
    const { body } = await list("?limit=100&q=%25");

    expect(ours(body.items)).toEqual([]);
  });

  it("rejects a limit above the cap", async () => {
    const { status, body } = await list("?limit=1000");

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("an unpublished registryType yields an empty list", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/registries/asset?limit=100",
    });

    expect(response.statusCode).toBe(200);
    expect(ours(response.json().items)).toEqual([]);
  });
});
