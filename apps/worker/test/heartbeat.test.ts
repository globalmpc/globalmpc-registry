import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { createHeartbeat, recordHeartbeat } from "../src/heartbeat.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Worker liveness signal.
 *
 * Without it, "nothing to scan" and "no worker to scan" are indistinguishable.
 * Two things are guarded here — **the signal is recorded** and **the signal does not interfere with
 * the loop**.
 */
describeDb("worker liveness signal", () => {
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

  it("records the signal and updates it on the next call", async () => {
    expect(await recordHeartbeat(sql, "scan", { handled: false })).toBe(true);
    const [first] = await sql<{ last_seen_at: Date }[]>`
      SELECT last_seen_at FROM core.worker_heartbeats WHERE worker_kind = 'scan'
    `;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await recordHeartbeat(sql, "scan", { handled: true })).toBe(true);

    const rows = await sql<{ last_seen_at: Date; detail: { handled: boolean } }[]>`
      SELECT last_seen_at, detail FROM core.worker_heartbeats WHERE worker_kind = 'scan'
    `;
    // One row per kind. INSERTing every cycle would grow the table without bound.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_seen_at.getTime()).toBeGreaterThan(first!.last_seen_at.getTime());
    expect(rows[0]!.detail.handled).toBe(true);
  });

  it("does not rewrite within the interval", async () => {
    // The scan worker's default cycle is 3 seconds. Writing every cycle runs an UPDATE every few
    // seconds, and that load outweighs the signal's value.
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

  it("does not throw when the write fails", async () => {
    // Failing to record the signal is not failing to do the work. Stopping the work over the signal
    // would let observability reduce availability.
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

  it("the DB rejects an unknown kind", async () => {
    // A new kind needs matching alert rules. The CHECK constraint keeps a typo from creating a new
    // kind.
    await expect(
      sql`INSERT INTO core.worker_heartbeats (worker_kind) VALUES ('typo')`,
    ).rejects.toThrow();
  });
});
