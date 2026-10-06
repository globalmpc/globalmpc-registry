import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Workspace aggregation.
 *
 * The two screens were missing not for lack of data but because data showed only after
 * opening a single project. This checks **that aggregation respects tenant boundaries** and
 * **that "my to-dos" and "what I am waiting on" do not mix**.
 */
describeDb("workspace aggregation", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorAToken: string;
  let operatorBToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);
    operatorBToken = await signIn(app, fx.operatorB);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  it("reports publish status without opening a project", async () => {
    const publicKey = `WS-${randomUUID().slice(0, 8)}`;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorAToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["Legal title verification is outside this review's scope"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    const listed = await get(operatorAToken, "/api/v1/registry-entries");
    expect(listed.statusCode).toBe(200);

    const mine = listed
      .json()
      .items.find((item: { publicKey: string }) => item.publicKey === publicKey);
    expect(mine).toBeDefined();
    expect(mine.status).toBe("published");
    // Publishing and anchoring are separate events. Merging them reads as "published, so
    // it is on-chain".
    expect(mine.anchored).toBe(false);
  });

  it("does not return another tenant's records", async () => {
    const a = await get(operatorAToken, "/api/v1/registry-entries");
    const b = await get(operatorBToken, "/api/v1/registry-entries");

    const aKeys = new Set(a.json().items.map((item: { entryId: string }) => item.entryId));
    for (const item of b.json().items) {
      expect(aKeys.has(item.entryId)).toBe(false);
    }
  });

  it("keeps what I am waiting on apart from what I must decide", async () => {
    const subject = (
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/subjects",
        headers: {
          authorization: `Bearer ${operatorAToken}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: { displayName: `My work target ${randomUUID().slice(0, 6)}` },
      })
    ).json();

    await app.inject({
      method: "POST",
      url: "/api/v1/admin/role-grants",
      headers: { authorization: `Bearer ${operatorAToken}`, "idempotency-key": idempotencyKey() },
      payload: { subjectId: subject.id, role: "auditor", reason: "audit duty" },
    });

    const mine = (await get(operatorAToken, "/api/v1/my-work")).json();

    // I made the proposal — nothing for me to do.
    expect(mine.waitingOnOthers.some((item: { id: string }) => item.id)).toBe(true);
    // If the same proposal also appears under "to decide", both lists lose meaning.
    const waitingIds = new Set(mine.waitingOnOthers.map((item: { id: string }) => item.id));
    for (const item of mine.unassigned) {
      if (item.kind === "role_grant_decision") {
        expect(waitingIds.has(item.id)).toBe(false);
      }
    }
  });

  it("lists unassigned items separately", async () => {
    // If only assigned work shows, work nobody owns never shows.
    const response = await get(operatorAToken, "/api/v1/my-work");

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().unassigned)).toBe(true);
    expect(Array.isArray(response.json().assignedToMe)).toBe(true);
  });
});
