import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * The signed-in "me" screen.
 *
 * 1. My activity holds only what this wallet's subject did. Other people's records in the
 *    same tenant do not appear here, whatever the role.
 * 2. The session returns the allowed action list. Menus filter by it.
 */
describeDb("my activity and session actions", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operator: string; steward: string; reader: string };
  const created: string[] = [];

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    tokens = {
      operator: await signIn(app, fx.operatorA),
      steward: await signIn(app, fx.stewardA),
      reader: await signIn(app, fx.readerA),
    };

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...bearer(tokens.operator), "idempotency-key": idempotencyKey() },
        payload: {
          projectKey: `ACT-${randomUUID().slice(0, 8)}`,
          name: "activity test",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId: fx.orgA,
        },
      });
      expect(response.statusCode).toBe(200);
      created.push((response.json() as { id: string }).id);
    }
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function activity(token: string | null, query = "") {
    return app.inject({
      method: "GET",
      url: `/api/v1/me/activity${query}`,
      headers: token ? bearer(token) : {},
    });
  }

  it("lists what I did", async () => {
    const response = await activity(tokens.operator);
    expect(response.statusCode).toBe(200);
    const ids = (response.json() as { items: { resourceId: string | null }[] }).items.map(
      (item) => item.resourceId,
    );
    for (const id of created) expect(ids).toContain(id);
  });

  it("does not list what others did", async () => {
    const response = await activity(tokens.steward);
    expect(response.statusCode).toBe(200);
    const ids = (response.json() as { items: { resourceId: string | null }[] }).items.map(
      (item) => item.resourceId,
    );
    for (const id of created) expect(ids).not.toContain(id);
  });

  it("fetches the next page with cursor", async () => {
    const first = (await activity(tokens.operator, "?limit=1")).json() as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = (await activity(tokens.operator, `?limit=1&cursor=${first.nextCursor}`)).json() as {
      items: { id: string }[];
    };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  });

  it("returns 401 when not signed in", async () => {
    const response = await activity(null);
    expect(response.statusCode).toBe(401);
  });

  it("a wallet with no organization gets 403 WALLET_NOT_ENROLLED, not 401", async () => {
    // Any wallet can sign in by signature. If the later rejection reads as "sign in
    // again", users repeat the same signature.
    const unbound = await signIn(app, newAccount());

    for (const url of ["/api/v1/projects", "/api/v1/my-work", "/api/v1/me/activity"]) {
      const response = await app.inject({ method: "GET", url, headers: bearer(unbound) });
      expect(response.statusCode).toBe(403);
      const body = response.json() as { code: string; details?: { accessRequestPath?: string } };
      expect(body.code).toBe("WALLET_NOT_ENROLLED");
      expect(body.details?.accessRequestPath).toBe("/w/access-requests");
    }
  });

  it("the session reports only role-allowed actions", async () => {
    const steward = (
      await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(tokens.steward) })
    ).json() as { actions: string[] };
    expect(steward.actions).toContain("source.upload");
    expect(steward.actions).not.toContain("admin.read");
    // Authorization internals are not sent to the UI.
    expect(steward).not.toHaveProperty("organizationProjectIds");

    const reader = (
      await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(tokens.reader) })
    ).json() as { actions: string[] };
    expect(reader.actions).toEqual([]);
  });
});
