import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 이 묶음은 DB 없이 돈다. 상한이 DB보다 앞에 있는지를 실제 hook 순서로 확인한다.
 * 가짜 SQL은 호출 횟수만 세므로, 429 요청이 세션 조회에 닿으면 바로 드러난다.
 */
describe("검증 전 요청 상한", () => {
  let app: FastifyInstance;
  let sqlCalls: number;

  beforeAll(async () => {
    sqlCalls = 0;
    const fakeSql = (async () => {
      sqlCalls += 1;
      return [];
    }) as unknown as postgres.Sql;

    app = await buildServer(
      loadConfig(
        testEnv({
          DATABASE_URL: "postgres://unused",
          RATE_LIMIT_MAX: "2",
          AUTH_RATE_LIMIT_MAX: "2",
        }),
      ),
      fakeSql,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("가짜 Bearer를 바꿔도 새 몫을 얻지 못하고 429는 세션 DB를 읽지 않는다", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: {
          authorization: `Bearer different-invalid-token-${attempt}`,
          "x-forwarded-for": "203.0.113.20",
        },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429, 429]);
    // 허용된 두 요청만 resolve_session_token을 호출한다.
    expect(sqlCalls).toBe(2);
  });

  it("SIWE는 Bearer 헤더를 무시하고 IP별 좁은 상한을 적용한다", async () => {
    const callsBefore = sqlCalls;
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        headers: {
          authorization: `Bearer different-invalid-token-${attempt}`,
          "x-forwarded-for": "203.0.113.21",
        },
        payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([200, 200, 429, 429]);
    // SIWE route에서는 세션 조회를 생략하고 허용된 nonce INSERT만 수행한다.
    expect(sqlCalls - callsBefore).toBe(2);
  });
});

/**
 * 요청 상한 — 06 §6.9.
 *
 * 계약은 무인증 경로에 별도 상한이 있다고 밝힌다. 다른 테스트는 상한을 넉넉히
 * 두고 돌기 때문에, 상한이 실제로 걸리는지는 **여기서만** 확인된다.
 */
describeDb("요청 상한", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(
      loadConfig(testEnv({ RATE_LIMIT_MAX: "50", AUTH_RATE_LIMIT_MAX: "3" })),
      fx.appSql,
    );
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function nonce() {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/siwe/nonce",
      payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
    });
  }

  it("로그인 경로는 좁은 상한을 갖는다", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await nonce()).statusCode);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it("상한에 걸려도 envelope 형식을 지킨다 — 화면이 다음 행동을 안다", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) await nonce();

    const response = await nonce();
    expect(response.statusCode).toBe(429);

    const body = response.json() as {
      code: string;
      retryable: boolean;
      correlationId: string;
      details?: { retryAfterSeconds?: string };
    };
    expect(body.code).toBe("RATE_LIMITED");
    // 상한은 시간이 지나면 풀린다. 재시도 불가로 표시하면 사용자가 포기한다.
    expect(body.retryable).toBe(true);
    expect(body.correlationId).not.toBe("unknown");
    expect(body.details?.retryAfterSeconds).toBeDefined();
  });

  it("운영 endpoint는 상한에서 제외된다 — 수집 주기가 상한을 먹지 않는다", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      statuses.push((await app.inject({ method: "GET", url: "/health/live" })).statusCode);
    }

    expect(statuses.every((status) => status === 200)).toBe(true);
  });
});

/**
 * 프록시 뒤에서의 요청 상한 — 06 §6.9.
 *
 * 배포에서 API는 `web`의 `/api/*` 프록시를 지나서만 도달한다(`apps/web/src/proxy.ts`).
 * 그러면 API가 보는 소켓 주소는 **모든 요청에서 web 컨테이너 하나**다. 상한 키가
 * 그 주소로 떨어지면 무인증 경로(SIWE nonce·verify)의 상한이 사이트 전체 합산이
 * 되어, 한 사람이 10회를 쓰면 그 분에는 아무도 로그인하지 못한다.
 *
 * 그래서 **신뢰하는 홉 수만큼 `x-forwarded-for`의 오른쪽에서 세어** 요청자를
 * 정한다. 왼쪽은 요청자가 마음대로 채울 수 있으므로 세지 않는다.
 */
describeDb("프록시 뒤의 요청 상한", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(
      loadConfig(testEnv({ RATE_LIMIT_MAX: "50", AUTH_RATE_LIMIT_MAX: "2" })),
      fx.appSql,
    );
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function nonce(forwardedFor: string | undefined) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/siwe/nonce",
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
      payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
    });
  }

  it("요청자마다 상한을 따로 센다 — 한 사람이 전체 로그인을 막지 못한다", async () => {
    const first: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      first.push((await nonce("203.0.113.10")).statusCode);
    }
    expect(first).toEqual([200, 200, 429]);

    // 앞 사람이 자기 몫을 다 썼어도 다른 요청자는 그대로 쓴다.
    expect((await nonce("203.0.113.11")).statusCode).toBe(200);
  });

  it("헤더 왼쪽에 값을 덧붙여도 새 몫을 얻지 못한다 — 상한 우회가 안 된다", async () => {
    expect((await nonce("198.51.100.7")).statusCode).toBe(200);
    expect((await nonce("198.51.100.7")).statusCode).toBe(200);
    expect((await nonce("198.51.100.7")).statusCode).toBe(429);

    // 신뢰하지 않는 왼쪽 항목이 바뀌어도 오른쪽이 같으면 같은 몫이다.
    expect((await nonce("9.9.9.9, 198.51.100.7")).statusCode).toBe(429);
    expect((await nonce("1.1.1.1, 2.2.2.2, 198.51.100.7")).statusCode).toBe(429);
  });
});

/**
 * 홉 수가 틀렸다는 것을 서버가 스스로 말하게 한다.
 *
 * `TRUSTED_PROXY_HOPS`가 실제 프록시 수보다 작으면 요청자가 컨테이너의 사설
 * 주소로 판정된다 — 상한이 사이트 전체 합산이 되는 상태다. 이 상태는 오류 없이
 * 200을 돌려주므로 사람이 알아챌 신호가 없다. 그래서 상한 키가 사설 주소로
 * 떨어지는 첫 순간에 경고를 남긴다.
 */
describeDb("요청자 주소 경고", () => {
  let fx: TestFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.close();
  });

  async function warningsFor(forwardedFor: string | undefined): Promise<string> {
    const app = await buildServer(loadConfig(testEnv()), fx.appSql);
    const collected: unknown[] = [];
    app.log.warn = ((...args: unknown[]) => {
      collected.push(args);
    }) as typeof app.log.warn;

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/siwe/nonce",
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
      payload: { walletAddress: `0x${"ab".repeat(20)}`, chainId: 97 },
    });
    await app.close();

    return JSON.stringify(collected);
  }

  it("사설 주소로 판정되면 무엇이 잘못됐는지 이름을 대고 알린다", async () => {
    expect(await warningsFor(undefined)).toMatch(/TRUSTED_PROXY_HOPS/);
  });

  it("공인 주소로 판정되면 아무 말도 하지 않는다 — 정상 배포에서 소음이 없다", async () => {
    expect(await warningsFor("203.0.113.7")).not.toMatch(/TRUSTED_PROXY_HOPS/);
  });
});
