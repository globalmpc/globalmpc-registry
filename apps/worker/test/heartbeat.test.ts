import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { createHeartbeat, recordHeartbeat } from "../src/heartbeat.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * worker 생존 신호.
 *
 * 이 신호가 없으면 "검사할 것이 없다"와 "검사할 worker가 없다"가 구분되지 않는다.
 * 여기서 지키는 것은 둘이다 — **신호가 남는가**와 **신호가 루프를 방해하지
 * 않는가**.
 */
describeDb("worker 생존 신호", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await connectIsolated("heartbeat");
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM core.worker_heartbeats`;
  });

  it("신호를 남기고 다시 부르면 갱신한다", async () => {
    expect(await recordHeartbeat(sql, "scan", { handled: false })).toBe(true);
    const [first] = await sql<{ last_seen_at: Date }[]>`
      SELECT last_seen_at FROM core.worker_heartbeats WHERE worker_kind = 'scan'
    `;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await recordHeartbeat(sql, "scan", { handled: true })).toBe(true);

    const rows = await sql<{ last_seen_at: Date; detail: { handled: boolean } }[]>`
      SELECT last_seen_at, detail FROM core.worker_heartbeats WHERE worker_kind = 'scan'
    `;
    // 종류마다 한 행이다. 매 주기 INSERT하면 표가 무한히 자란다.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_seen_at.getTime()).toBeGreaterThan(first!.last_seen_at.getTime());
    expect(rows[0]!.detail.handled).toBe(true);
  });

  it("간격 안에서는 다시 쓰지 않는다", async () => {
    // scan worker의 기본 주기는 3초다. 그대로 쓰면 초당 한 번씩 UPDATE가 돌고
    // 그 부하가 신호의 값보다 크다.
    const heartbeat = createHeartbeat(sql, "outbox", 60_000);

    await heartbeat({ published: 0 });
    const [first] = await sql<{ last_seen_at: Date }[]>`
      SELECT last_seen_at FROM core.worker_heartbeats WHERE worker_kind = 'outbox'
    `;

    await new Promise((resolve) => setTimeout(resolve, 20));
    await heartbeat({ published: 1 });

    const [second] = await sql<{ last_seen_at: Date; detail: { published: number } }[]>`
      SELECT last_seen_at, detail FROM core.worker_heartbeats WHERE worker_kind = 'outbox'
    `;
    expect(second!.last_seen_at.getTime()).toBe(first!.last_seen_at.getTime());
    expect(second!.detail.published).toBe(0);
  });

  it("쓰지 못해도 던지지 않는다", async () => {
    // 신호를 못 남긴 것과 일을 못 한 것은 다르다. 전자 때문에 후자를 멈추면
    // 관측이 가용성을 깎는다.
    const closed = postgres("postgres://invalid:invalid@127.0.0.1:1/none", {
      connect_timeout: 1,
      max: 1,
    });
    try {
      expect(await recordHeartbeat(closed, "anchor")).toBe(false);
    } finally {
      await closed.end({ timeout: 1 }).catch(() => undefined);
    }
  });

  it("알 수 없는 종류는 DB가 거절한다", async () => {
    // 종류가 늘면 알림 규칙도 같이 늘어야 한다. 오타로 새 종류가 생기지 않게
    // CHECK이 막는다.
    await expect(
      sql`INSERT INTO core.worker_heartbeats (worker_kind) VALUES ('typo')`,
    ).rejects.toThrow();
  });
});
