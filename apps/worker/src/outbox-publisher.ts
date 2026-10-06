import type postgres from "postgres";

/**
 * Outbox publishing — 07 §7.5.
 *
 * **At-least-once.** `published_at` is written after a successful publish, so a crash right
 * after publishing can resend the same event. Consumers therefore deduplicate in `core.inbox`
 * by `(eventId, handlerVersion)`.
 *
 * The reverse order (mark first, then publish) is at-most-once and loses events. Consumers can
 * absorb duplicates; a loss cannot be recovered.
 */

export interface OutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly project_id: string | null;
  readonly payload: Record<string, unknown>;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly occurred_at: Date;
}

export type Publish = (event: OutboxRow) => Promise<void>;

export interface PublishResult {
  readonly published: number;
  readonly failed: number;
}

/**
 * Publishes one batch of unpublished events.
 *
 * A failed publish does not stop the rest. If one blocked event halted the batch, unrelated
 * events would be delayed too. Failed events keep an empty `published_at` and are retried on
 * the next call.
 */
export async function publishBatch(
  sql: postgres.Sql,
  publish: Publish,
  limit = 100,
): Promise<PublishResult> {
  const rows = await sql<OutboxRow[]>`
    SELECT * FROM core.outbox
    WHERE published_at IS NULL
    ORDER BY occurred_at, id
    LIMIT ${limit}
  `;

  let published = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await publish(row);
    } catch {
      failed += 1;
      continue;
    }
    await sql`UPDATE core.outbox SET published_at = now() WHERE id = ${row.id}`;
    published += 1;
  }

  return { published, failed };
}

/**
 * Consumer-side deduplication — 07 §7.5.
 *
 * Keeps an at-least-once receiver from processing the same event twice. `handlerVersion` is
 * part of the key because a handler logic change may require reprocessing past events.
 */
export async function claimEvent(
  sql: postgres.Sql,
  eventId: string,
  handlerVersion: string,
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO core.inbox (event_id, handler_version)
    VALUES (${eventId}, ${handlerVersion})
    ON CONFLICT (event_id, handler_version) DO NOTHING
    RETURNING event_id
  `;
  return rows.length > 0;
}

export interface BacklogStats {
  readonly pending: number;
  readonly oldestPendingAt: Date | null;
}

/**
 * Unpublished backlog. Used by the operator screen and alerts.
 *
 * 06 §6.8: no hidden success on failure. If a growing backlog cannot be observed, nobody
 * knows events have stopped.
 */
export async function backlogStats(sql: postgres.Sql): Promise<BacklogStats> {
  const [row] = await sql<{ pending: string; oldest: Date | null }[]>`
    SELECT count(*)::text AS pending, min(occurred_at) AS oldest
    FROM core.outbox WHERE published_at IS NULL
  `;
  return {
    pending: Number(row?.pending ?? "0"),
    oldestPendingAt: row?.oldest ?? null,
  };
}
