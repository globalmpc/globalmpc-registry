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
 * 계약↔구현 대조.
 *
 * ADR-T05는 "런타임 검증과 문서가 같은 정의에서 나온다"였지만, 스키마만 공유하고
 * **route 등록은 수동**이라 둘이 갈라질 수 있다. 실제로 갈라졌다 —
 * `GET /api/v1/projects`가 계약 없이 구현됐다.
 *
 * 이 파일이 그 드리프트를 양방향으로 잡는다.
 *
 * - 계약에 `implemented: true`인데 등록되지 않은 route → 실패
 * - 등록됐는데 계약에 없는 `/api/v1/**` route → 실패
 *
 * 운영 endpoint(`/health/*`)는 API 계약의 대상이 아니므로 제외한다.
 */

const API_PREFIX = "/api/v1";

function isApiRoute(url: string): boolean {
  return url.startsWith(API_PREFIX);
}

describeDb("계약↔구현 parity", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorA: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // R1부터 인증은 SIWE 서명 → 세션 토큰이다. 테스트도 같은 경로를 지난다.
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
        // Fastify가 자동 등록하는 HEAD는 GET의 부산물이라 대조 대상이 아니다.
        .filter((route) => route.method !== "HEAD")
        .map((route) => `${route.method} ${route.url}`),
    );
  }

  it("계약에서 구현됐다고 표시한 route가 전부 등록돼 있다", () => {
    const registered = registeredApiRoutes();
    const missing = implementedRoutes()
      .map((route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`)
      .filter((key) => !registered.has(key));

    expect(missing, "계약에는 implemented인데 서버에 등록되지 않았다").toEqual([]);
  });

  it("등록된 API route가 전부 계약에 있다", () => {
    const contracted = new Set(
      ROUTES.map((route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`),
    );
    const undocumented = [...registeredApiRoutes()].filter((key) => !contracted.has(key));

    expect(undocumented, "구현됐지만 계약(ROUTES)에 없다").toEqual([]);
  });

  it("계약이 planned로 표시한 route는 아직 등록되지 않았다", () => {
    const registered = registeredApiRoutes();
    const unexpected = plannedRoutes()
      .map((route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`)
      .filter((key) => registered.has(key));

    expect(
      unexpected,
      "구현했으면 계약의 implemented 플래그를 true로 바꿔야 한다",
    ).toEqual([]);
  });

  it("남은 작업이 release별로 집계된다", () => {
    const byRelease = new Map<string, string[]>();
    for (const route of plannedRoutes()) {
      const release = route.plannedRelease ?? "unassigned";
      byRelease.set(release, [...(byRelease.get(release) ?? []), route.operationId]);
    }

    // 미구현 route는 반드시 release가 지정돼 있어야 한다. 지정 없이 남으면
    // 언제 만들지 아무도 모르는 채로 계약에만 존재하게 된다.
    // planned가 0인 것은 정상이다 — 계약의 모든 route가 구현됐다는 뜻이다.
    expect(byRelease.get("unassigned") ?? []).toEqual([]);
    expect(plannedRoutes().length).toBe([...byRelease.values()].flat().length);
  });

  it("구현된 mutation route는 실제로 Idempotency-Key를 요구한다", async () => {
    const mutations = implementedRoutes().filter((route) => route.mutation);
    expect(mutations.length).toBeGreaterThan(0);

    for (const route of mutations) {
      const response = await app.inject({
        method: route.method.toUpperCase() as "POST",
        url: toFastifyPath(route.path).replace(/:[^/]+/g, "00000000-0000-0000-0000-000000000000"),
        headers: { authorization: `Bearer ${tokens.operatorA}` },
        payload: {},
      });
      // key가 없으면 400 IDEMPOTENCY_KEY_REQUIRED여야 한다. 요청 본문 검증보다
      // 먼저 걸려야 재시도 안전성이 보장된다.
      expect(response.statusCode, route.operationId).toBe(400);
      expect(response.json().code, route.operationId).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });

  it("계약이 If-Match를 요구한 route는 실제로 그것 없이 거절한다", async () => {
    const guarded = implementedRoutes().filter((route) => route.requiresIfMatch);
    // 이 목록이 비면 검사가 아무것도 하지 않는다. 07 §7.1이 요구하는 이상
    // 최소 하나는 있어야 한다.
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

      // 428이어야 한다. 412로 답하면 "버전이 틀렸다"로 읽혀 헤더가 빠졌다는
      // 사실이 가려진다.
      expect(response.statusCode, route.operationId).toBe(428);
      expect(response.json().code, route.operationId).toBe("IF_MATCH_REQUIRED");
    }
  });

  it("If-Match를 요구하지 않는 mutation은 그 헤더 없이도 진행한다", async () => {
    // 계약이 false라고 적어 두고 구현이 요구하면 클라이언트는 계약을 믿을 수 없다.
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

  it("공개 route는 인증 없이도 404가 아니다", async () => {
    const publicImplemented = implementedRoutes().filter(
      (route) => route.public && route.method === "post",
    );

    for (const route of publicImplemented) {
      const response = await app.inject({
        method: "POST",
        url: route.path,
        payload: {},
      });
      // 본문이 비어 400이 나오는 것은 정상이다. 404면 라우트가 없는 것이다.
      expect(response.statusCode, route.operationId).not.toBe(404);
    }
  });
});
