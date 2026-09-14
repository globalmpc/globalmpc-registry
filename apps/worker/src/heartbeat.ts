import type postgres from "postgres";

/**
 * Worker liveness signal.
 *
 * **Why:** there was no way to tell whether the three workers (outbox, anchor, scan) were alive.
 * `scan` in particular can be switched off by a compose profile, and when off, uploads stall in
 * `quarantined`. That stall **looks like waiting, not an error.**
 *
 * Counting queued rows is not enough. A deployment with no uploads yet shows 0, and that 0 is
 * indistinguishable from "healthy". A signal the worker emits itself appears even with an empty
 * queue.
 *
 * **A failure does not stop the loop.** Failing to emit a signal differs from failing to work;
 * stopping the latter over the former lets observability cut availability. Instead of passing
 * silently, it returns a result so the caller can log it.
 */
export type WorkerKind = "outbox" | "anchor" | "scan";

export async function recordHeartbeat(
  sql: postgres.Sql,
  kind: WorkerKind,
  detail?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at, detail)
      VALUES (${kind}, now(), ${detail ? sql.json(detail as never) : null})
      ON CONFLICT (worker_kind) DO UPDATE
      SET last_seen_at = now(), detail = EXCLUDED.detail
    `;
    return true;
  } catch {
    return false;
  }
}

/**
 * Emits **at an interval**, not every cycle.
 *
 * The scan worker's default cycle is 3 s. Using it as is runs an UPDATE every few seconds, and
 * that load outweighs the signal's value. Alerts are judged in minutes, so 15 s is enough.
 */
export function createHeartbeat(
  sql: postgres.Sql,
  kind: WorkerKind,
  intervalMs = 15_000,
): (detail?: Record<string, unknown>) => Promise<void> {
  let lastAt = 0;
  return async (detail) => {
    const now = Date.now();
    if (now - lastAt < intervalMs) return;
    lastAt = now;
    await recordHeartbeat(sql, kind, detail);
  };
}
