import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 부하 특성 — spec 06 §6.9.
 *
 * 이것은 성능 벤치마크가 아니다. 절대 수치는 기계마다 다르고 CI에서 재현되지
 * 않는다. **동시성 아래에서 불변조건이 깨지지 않는가**를 본다.
 *
 * - 같은 Idempotency-Key로 동시에 들어온 요청이 하나만 반영되는가
 * - 동시 mutation이 버전을 건너뛰거나 덮어쓰지 않는가
 * - RLS가 부하 아래에서도 tenant를 섞지 않는가
 * - 연결 풀이 고갈되어도 오류가 조용히 성공으로 바뀌지 않는가
 *
 * 순차 실행에서는 절대 나타나지 않는 것들이라 별도 파일로 둔다.
 */
describeDb("동시성 아래 불변조건", () => {
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
        name: "부하 확인용",
        hostCountryIso3: "MNG",
        minerals: ["copper"],
        ownerOrganizationId: fx.orgA,
      },
    });
  }

  it("같은 Idempotency-Key로 동시에 들어와도 하나만 만들어진다", async () => {
    const key = `LOAD-IDEM-${Date.now()}`;
    const idem = idempotencyKey();

    // 네트워크 재시도는 순차가 아니라 동시에 온다. 순차 테스트는 이것을 못 잡는다.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => createProject(operatorToken, key, idem)),
    );

    const created = responses.filter((response) => response.statusCode === 200);
    expect(created.length).toBeGreaterThan(0);

    // 성공한 것들은 모두 같은 프로젝트를 가리켜야 한다.
    const ids = new Set(created.map((response) => response.json().id));
    expect(ids.size).toBe(1);

    const rows = await fx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM core.projects WHERE project_key = ${key}
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("서로 다른 key는 동시에 와도 각각 만들어진다", async () => {
    const stamp = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createProject(operatorToken, `LOAD-MANY-${stamp}-${index}`, idempotencyKey()),
      ),
    );

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.json().id)).size).toBe(10);
  });

  it("동시 conflict 기록이 버전을 건너뛰지 않는다", async () => {
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

    // 같은 버전을 본 10명이 동시에 기록한다.
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
    // If-Match가 없으면 10개가 모두 통과하고 9명의 판단이 사라진다.
    expect(succeeded).toHaveLength(1);

    const [row] = await fx.sql<{ version: number }[]>`
      SELECT version FROM core.claims WHERE id = ${claim.id}
    `;
    expect(row!.version).toBe(claim.version + 1);
  });

  it("동시 부하에서도 tenant가 섞이지 않는다", async () => {
    const stamp = Date.now();

    // 두 tenant가 번갈아 요청한다. 연결 풀을 공유하므로 세션 변수가 새면
    // 여기서 드러난다.
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
    // 한 건이라도 섞이면 RLS가 부하 아래에서 깨진 것이다.
    expect(keys.filter((key) => key.startsWith(`LOAD-B-${stamp}`))).toEqual([]);
  });

  it("동시 읽기가 오류 없이 처리된다", async () => {
    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        app.inject({
          method: "GET",
          url: "/api/v1/projects",
          headers: { authorization: `Bearer ${operatorToken}` },
        }),
      ),
    );

    // 연결 풀이 모자라면 대기하거나 503이어야 한다. 조용히 빈 목록을 주면
    // 데이터가 없는 것과 구분되지 않는다.
    for (const response of responses) {
      expect([200, 503]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        expect(Array.isArray(response.json().items)).toBe(true);
      }
    }
  });

  it("동시 요청의 requestId가 서로 다르다", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: "GET",
          url: "/api/v1/projects",
          headers: { authorization: `Bearer ${operatorToken}` },
        }),
      ),
    );

    // 같은 값이 나오면 추적이 무의미해진다 — 로그에서 요청을 구분할 수 없다.
    const ids = responses.map((response) => response.headers["x-request-id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
