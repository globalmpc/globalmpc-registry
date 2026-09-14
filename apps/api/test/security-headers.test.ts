import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { testEnv } from "./helpers/db.js";
import { securityHeaders } from "../src/plugins/security-headers.js";

/**
 * API는 JSON만 돌려준다. 그러므로 이 표면의 CSP는 허용 목록이 아니라 전면 차단이
 * 맞다 — 10 §10.6.
 */
describe("보안 헤더 값", () => {
  it("아무 자원도 불러오지 않는다", () => {
    const headers = securityHeaders({ production: false });
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("base-uri 'none'");
  });

  it("MIME sniffing과 frame 삽입을 막는다", () => {
    const headers = securityHeaders({ production: false });
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  it("referrer와 브라우저 기능을 기본 차단한다", () => {
    const headers = securityHeaders({ production: false });
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toContain("geolocation=()");
  });

  /**
   * 로컬은 http다. 거기서 HSTS를 받은 브라우저는 그 호스트를 https로 강제
   * 기억하고, 같은 호스트명을 쓰는 다른 로컬 프로젝트까지 접속이 막힌다.
   */
  it("HSTS는 production에서만 나간다", () => {
    expect(securityHeaders({ production: false })["strict-transport-security"]).toBeUndefined();
    const prod = securityHeaders({ production: true })["strict-transport-security"];
    expect(prod).toContain("max-age=");
    expect(prod).toContain("includeSubDomains");
  });
});

/**
 * 값이 맞는 것으로는 부족하다. 훅이 실제로 걸렸는지, 그리고 **정상 응답이 아닌
 * 경우에도** 나가는지를 서버를 띄워 확인한다. 오류와 상한 초과 응답에서 헤더가
 * 빠지는 것이 흔한 구멍이고, 값이 반사돼 나갈 가능성이 가장 큰 곳도 그쪽이다.
 *
 * DB는 쓰지 않는다. 헤더는 라우트 처리보다 앞이므로 가짜 SQL로 충분하다.
 */
describe("보안 헤더가 모든 응답에 붙는다", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const fakeSql = (async () => []) as unknown as postgres.Sql;
    app = await buildServer(
      loadConfig(testEnv({ DATABASE_URL: "postgres://unused", RATE_LIMIT_MAX: "2" })),
      fakeSql,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("404 응답에 붙는다", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("인증 실패 응답에 붙는다", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("상한 초과 응답에도 붙는다", async () => {
    let last = await app.inject({ method: "GET", url: "/api/v1/projects" });
    for (let i = 0; i < 4 && last.statusCode !== 429; i += 1) {
      last = await app.inject({ method: "GET", url: "/api/v1/projects" });
    }
    expect(last.statusCode).toBe(429);
    expect(last.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
