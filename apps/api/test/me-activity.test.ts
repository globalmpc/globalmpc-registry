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
 * 로그인 뒤 "나"의 화면.
 *
 * 1. 내 활동은 이 지갑의 주체가 한 일만 담는다. 같은 tenant의 다른 사람 기록은
 *    역할이 있어도 여기로 나오지 않는다.
 * 2. 세션은 허용 action 목록을 준다. 메뉴는 그것으로 거른다.
 */
describeDb("내 활동과 세션 action", () => {
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
          name: "활동 시험",
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

  it("내가 한 일이 나온다", async () => {
    const response = await activity(tokens.operator);
    expect(response.statusCode).toBe(200);
    const ids = (response.json() as { items: { resourceId: string | null }[] }).items.map(
      (item) => item.resourceId,
    );
    for (const id of created) expect(ids).toContain(id);
  });

  it("다른 사람이 한 일은 나오지 않는다", async () => {
    const response = await activity(tokens.steward);
    expect(response.statusCode).toBe(200);
    const ids = (response.json() as { items: { resourceId: string | null }[] }).items.map(
      (item) => item.resourceId,
    );
    for (const id of created) expect(ids).not.toContain(id);
  });

  it("cursor로 다음 쪽을 이어 받는다", async () => {
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

  it("로그인하지 않으면 401이다", async () => {
    const response = await activity(null);
    expect(response.statusCode).toBe(401);
  });

  it("조직에 묶이지 않은 지갑은 401이 아니라 403 WALLET_NOT_ENROLLED다", async () => {
    // 어느 지갑이든 서명으로 로그인은 된다. 그 뒤의 거절이 "다시 로그인하라"로
    // 읽히면 사용자는 같은 서명을 되풀이한다.
    const unbound = await signIn(app, newAccount());

    for (const url of ["/api/v1/projects", "/api/v1/my-work", "/api/v1/me/activity"]) {
      const response = await app.inject({ method: "GET", url, headers: bearer(unbound) });
      expect(response.statusCode).toBe(403);
      const body = response.json() as { code: string; details?: { accessRequestPath?: string } };
      expect(body.code).toBe("WALLET_NOT_ENROLLED");
      expect(body.details?.accessRequestPath).toBe("/w/access-requests");
    }
  });

  it("세션은 역할로 허용된 action만 알려 준다", async () => {
    const steward = (
      await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(tokens.steward) })
    ).json() as { actions: string[] };
    expect(steward.actions).toContain("source.upload");
    expect(steward.actions).not.toContain("admin.read");
    // 인가 내부 값은 화면에 주지 않는다.
    expect(steward).not.toHaveProperty("organizationProjectIds");

    const reader = (
      await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(tokens.reader) })
    ).json() as { actions: string[] };
    expect(reader.actions).toEqual([]);
  });
});
