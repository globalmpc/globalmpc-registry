import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 검사기 생존.
 *
 * `promote`는 `scanned_clean`에서만 전이하므로 검사 worker가 없는 배포에서
 * 업로드는 `quarantined`에 영원히 머문다. **그 정지는 오류가 아니라 대기처럼
 * 보인다** — 목록이 그 구분을 스스로 말하는지 본다.
 */
describeDb("검사기 생존 보고", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    stewardToken = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  beforeEach(async () => {
    await fx.sql`DELETE FROM core.worker_heartbeats WHERE worker_kind = 'scan'`;
  });

  function listUploads() {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { authorization: `Bearer ${stewardToken}` },
    });
  }

  it("한 번도 보고하지 않은 상태를 '대기'와 구분해 말한다", async () => {
    const response = await listUploads();

    expect(response.statusCode).toBe(200);
    expect(response.json().scanner.state).toBe("never_seen");
    // "왜 안 되나"에 답할 수 있어야 한다.
    expect(response.json().scanner.detail).toContain("quarantine");
  });

  it("최근 신호가 있으면 running이다", async () => {
    await fx.sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at)
      VALUES ('scan', now())
    `;

    const response = await listUploads();
    expect(response.json().scanner.state).toBe("running");
    expect(response.json().scanner.secondsSinceHeartbeat).toBeLessThan(5);
  });

  it("오래된 신호는 stale이다 — 없는 것과 구분한다", async () => {
    // 15초마다 남기므로 10분은 마흔 주기를 놓친 것이다.
    await fx.sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at)
      VALUES ('scan', now() - interval '10 minutes')
    `;

    const response = await listUploads();
    expect(response.json().scanner.state).toBe("stale");
    expect(response.json().scanner.secondsSinceHeartbeat).toBeGreaterThan(500);
  });

  it("생존 조회가 실패해도 목록은 나온다", async () => {
    // 알 수 없다는 것도 하나의 상태다. 관측이 가용성을 깎지 않는다.
    // 함수 자체를 없애 실패를 만든다.
    await fx.sql`ALTER FUNCTION core.seconds_since_worker_heartbeat(TEXT) RENAME TO seconds_since_worker_heartbeat_hidden`;
    try {
      const response = await listUploads();
      expect(response.statusCode).toBe(200);
      expect(response.json().scanner.state).toBe("unknown");
      expect(Array.isArray(response.json().items)).toBe(true);
    } finally {
      await fx.sql`ALTER FUNCTION core.seconds_since_worker_heartbeat_hidden(TEXT) RENAME TO seconds_since_worker_heartbeat`;
    }
  });

  it("게이지가 worker 생존을 담는다", async () => {
    await fx.sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at)
      VALUES ('scan', now() - interval '42 seconds')
    `;

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain('mpc_worker_seconds_since_heartbeat{state="scan"}');
  });

  it("한 번도 보고하지 않은 worker는 게이지에 나오지 않는다", async () => {
    // 0으로 내면 "방금 봤다"가 된다. 없는 것과 오래된 것을 알림 규칙이 각각
    // 다루게 한다 — `absent()`와 `> 300`.
    const metrics = await app.inject({ method: "GET", url: "/metrics" });

    expect(metrics.body).not.toContain('mpc_worker_seconds_since_heartbeat{state="scan"}');
  });

  it("업로드가 없어도 생존을 말한다", async () => {
    // 쌓인 행을 세는 지표는 큐가 비면 조용하다. 이것이 그 자리를 메운다.
    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.otherProjectA}/uploads`,
      headers: { authorization: `Bearer ${stewardToken}` },
    });

    expect(empty.statusCode).toBe(200);
    expect(empty.json().scanner.state).toBe("never_seen");
  });
});
