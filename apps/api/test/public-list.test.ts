import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PUBLIC_FIELD_ALLOWLIST } from "@mpc/domain";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 공개 목록·검색.
 *
 * 0009의 공개 조회는 `(registryType, publicKey)`를 이미 알아야 한다. 즉 무엇이
 * 있는지 물을 방법이 없었다. 이 파일이 검증하는 것은 "목록이 나온다"가 아니라
 * **목록이 훑는 과정에서 경계가 새지 않는가**다.
 */
describeDb("공개 Registry 목록·검색", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;
  /** 이 파일이 만든 entry의 publicKey. 다른 파일의 기록과 섞이지 않게 접두어를 둔다. */
  const prefix = `LIST-${randomUUID().slice(0, 8)}`;

  function projection(overrides: Record<string, unknown> = {}) {
    return {
      stableId: randomUUID(),
      status: "registered",
      version: "1",
      asOf: "2026-08-01T00:00:00.000Z",
      sourceAge: "12",
      staleStatus: "fresh",
      limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
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

    // 순서가 확정적이어야 페이지네이션을 검증할 수 있다. 게시를 직렬로 한다.
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

  it("식별자 없이 목록을 낸다", async () => {
    const { status, body } = await list("?limit=100");

    expect(status).toBe(200);
    expect(ours(body.items).map((item) => item.publicKey).sort()).toEqual([
      `${prefix}-A`,
      `${prefix}-B`,
      `${prefix}-C`,
    ]);
  });

  it("로그인하지 않고 조회된다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/registries/project?limit=1",
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * 이 파일의 핵심이다. 목록은 여러 tenant의 여러 entry를 훑으므로 한 줄이라도
   * 새면 전체가 샌다.
   */
  it("공개 allowlist 밖의 필드를 반환하지 않는다", async () => {
    const { body } = await list("?limit=100");

    for (const item of body.items) {
      const leaked = Object.keys(item.projection).filter(
        (field) => !(PUBLIC_FIELD_ALLOWLIST as readonly string[]).includes(field),
      );
      expect(leaked).toEqual([]);
    }
  });

  it("tenant를 드러내지 않는다", async () => {
    const { body } = await list("?limit=100");

    expect(JSON.stringify(body)).not.toContain(fx.tenantA);
    for (const item of body.items) {
      expect(Object.keys(item)).not.toContain("tenantId");
    }
  });

  it("정렬을 응답에 밝히고 클라이언트가 고를 수 없다", async () => {
    const { body } = await list("?limit=100");

    expect(body.sort).toBe("publishedAt:desc,entryId:desc");

    const rejected = await list("?limit=100&sort=projectName:asc");
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("INVALID_QUERY");
  });

  it("cursor로 이어 받으면 같은 줄을 두 번 주지 않는다", async () => {
    const first = await list("?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTypeOf("string");

    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    const firstKeys = first.body.items.map((item: { publicKey: string }) => item.publicKey);
    const secondKeys = second.body.items.map((item: { publicKey: string }) => item.publicKey);

    expect(secondKeys.some((key: string) => firstKeys.includes(key))).toBe(false);
  });

  it("마지막 페이지의 nextCursor는 null이다", async () => {
    const { body } = await list("?limit=100");

    expect(body.nextCursor).toBeNull();
  });

  it("조작된 cursor를 조용히 첫 페이지로 되돌리지 않는다", async () => {
    const { status, body } = await list("?cursor=not-a-real-cursor");

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_CURSOR");
  });

  it("projectName·hostCountry·mineral·publicKey로 검색한다", async () => {
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
   * `%`는 검색어이지 와일드카드가 아니다. 이스케이프하지 않으면 `%` 하나로
   * 전체가 나오고, 그것은 검색이 아니라 필터 우회다.
   */
  it("검색어의 LIKE 와일드카드를 글자로 다룬다", async () => {
    const { body } = await list("?limit=100&q=%25");

    expect(ours(body.items)).toEqual([]);
  });

  it("limit 상한을 넘기면 거절한다", async () => {
    const { status, body } = await list("?limit=1000");

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("게시되지 않은 registryType은 빈 목록이다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/registries/asset?limit=100",
    });

    expect(response.statusCode).toBe(200);
    expect(ours(response.json().items)).toEqual([]);
  });
});
