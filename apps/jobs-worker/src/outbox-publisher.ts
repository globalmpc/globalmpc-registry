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
 *
 * **Failures are retried, then dead-lettered.** Each failure pushes the next attempt back
 * exponentially. At the attempt cap the event is set aside (`dead_lettered_at`) and shown on
 * the ops screen; it leaves the publishing queue only through an explicit replay
 * (`outbox-replay.ts`). A cap is what keeps one poisoned event from being retried forever.
 *
 * **One event is sent by one worker.** Several worker processes may poll the same table. Each
 * event is claimed with `FOR UPDATE SKIP LOCKED` in a transaction that stays open through the
 * publish and the `published_at` / `attempts` update, so no other worker can pick it up until
 * that outcome is committed — and by then the row no longer matches the due filter. A lease
 * column (as in `scan-worker.ts`) was not used: a lease that runs out while a slow handler is
 * still working hands the event to a second worker, which is the double send this prevents. A
 * lease is needed there because the scan reports through the API, which re-locks the row;
 * outbox handlers only insert new outbox rows and never touch the one being published.
 *
 * A worker that dies mid-publish holds nothing: its session closes, Postgres rolls the
 * transaction back and the lock goes with it, so the event is due again at once. That resend is
 * the at-least-once case above, not a second concurrent send.
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
  readonly attempts: number;
  /** Handlers a replay excluded for this event (0065). */
  readonly skip_handlers: readonly string[];
}

export type Publish = (event: OutboxRow) => Promise<void>;

export interface PublishResult {
  readonly published: number;
  /** Failed this round and scheduled for another attempt. */
  readonly failed: number;
  /** Failed at the attempt cap and set aside. Counted in `failed` too. */
  readonly deadLettered: number;
}

/** Same cap and shape as notification delivery, so operators learn one rule. */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;

export interface PublishOptions {
  readonly limit?: number;
  readonly maxAttempts?: number;
  /** Delay before the second attempt; doubles each further attempt. */
  readonly backoffMs?: number;
  /** Called once when an event is dead-lettered, after the row is marked. */
  readonly onDeadLetter?: (event: OutboxRow) => Promise<void>;
}

/** Stored on the row and shown to operators. Bounded so an error body cannot grow the row. */
const MAX_ERROR_LENGTH = 300;

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

type Outcome = "published" | "failed" | "dead_lettered";

/**
 * Publishes one batch of due events.
 *
 * A failed publish does not stop the rest. If one blocked event halted the batch, unrelated
 * events would be delayed too.
 *
 * Events are claimed one at a time, each in its own transaction, rather than as one locked
 * batch. A batch transaction would commit every mark at the end, so a crash halfway would
 * resend the events already published; it would also keep the whole batch away from idle
 * workers while one slow event is handled.
 *
 * `publish` runs while the claiming transaction holds a pool connection. Handlers use their own
 * connections from the same pool, so the pool must allow more than one.
 */
export async function publishBatch(
  sql: postgres.Sql,
  publish: Publish,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const limit = options.limit ?? 100;
  const maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? 0;

  // Handled in this batch. With no backoff a failed event is due again at once; excluding it
  // keeps one batch from spending every attempt on it.
  const handled: string[] = [];
  let published = 0;
  let failed = 0;
  let deadLettered = 0;

  while (handled.length < limit) {
    const claimed = await sql.begin(async (tx) => {
      const [row] = await tx<OutboxRow[]>`
        SELECT id, tenant_id, event_type, schema_version, aggregate_id, aggregate_version,
               project_id, payload, correlation_id, causation_id, occurred_at, attempts,
               skip_handlers
        FROM core.outbox
        WHERE published_at IS NULL
          AND dead_lettered_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          AND id <> ALL(${handled}::uuid[])
        ORDER BY occurred_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (!row) return null;
      return { row, outcome: await publishClaimed(tx, row, publish, maxAttempts, backoffMs) };
    });
    if (!claimed) break;

    handled.push(claimed.row.id);
    if (claimed.outcome === "published") {
      published += 1;
      continue;
    }
    failed += 1;
    if (claimed.outcome === "dead_lettered") {
      deadLettered += 1;
      // After commit, so the hook sees the row already set aside and a failing hook cannot
      // undo the mark.
      await options.onDeadLetter?.(claimed.row);
    }
  }

  return { published, failed, deadLettered };
}

/** Publishes a claimed event and records the outcome in the claiming transaction. */
async function publishClaimed(
  tx: postgres.TransactionSql,
  row: OutboxRow,
  publish: Publish,
  maxAttempts: number,
  backoffMs: number,
): Promise<Outcome> {
  const attempt = row.attempts + 1;
  try {
    await publish(row);
  } catch (error) {
    const exhausted = attempt >= maxAttempts;
    const delaySeconds = Math.round((backoffMs * 2 ** (attempt - 1)) / 1000);
    await tx`
      UPDATE core.outbox
      SET attempts = ${attempt},
          last_error = ${describeError(error)},
          next_attempt_at = now() + ${`${delaySeconds} seconds`}::interval,
          dead_lettered_at = ${exhausted ? tx`now()` : null}
      WHERE id = ${row.id}
    `;
    return exhausted ? "dead_lettered" : "failed";
  }
  await tx`
    UPDATE core.outbox
    SET published_at = now(), attempts = ${attempt}, last_error = NULL
    WHERE id = ${row.id}
  `;
  return "published";
}

/**
 * An in-process consumer of outbox events.
 *
 * `name` is the side-effect kind a replay can exclude (`--skip-handler`). `version` is part of
 * the inbox key: bumping it makes a changed handler process past events again on replay.
 */
export interface OutboxHandler {
  readonly name: string;
  readonly version: string;
  accepts(eventType: string): boolean;
  handle(event: OutboxRow): Promise<void>;
  /** The event will not be retried any more. Settle whatever this handler left open. */
  onDeadLetter?(event: OutboxRow): Promise<void>;
}

export interface Dispatcher {
  readonly publish: Publish;
  readonly onDeadLetter: (event: OutboxRow) => Promise<void>;
}

/**
 * Fans one event out to every handler that accepts it.
 *
 * **The inbox row is written after the handler succeeds.** Writing it first would make a crash
 * between the two lose that handler's work for good; this order at worst repeats it, which the
 * at-least-once contract already requires handlers to tolerate. A handler that already finished
 * an event is skipped on retry, so one failing handler does not repeat the others' work.
 */
export function createDispatcher(
  sql: postgres.Sql,
  handlers: readonly OutboxHandler[],
): Dispatcher {
  const relevant = (event: OutboxRow) =>
    handlers.filter(
      (handler) => handler.accepts(event.event_type) && !event.skip_handlers.includes(handler.name),
    );

  return {
    publish: async (event) => {
      for (const handler of relevant(event)) {
        if (await alreadyProcessed(sql, event.id, handlerKey(handler))) continue;
        try {
          await handler.handle(event);
        } catch (error) {
          // Names the failing side effect so the ops screen says which consumer is stuck.
          throw new Error(`${handler.name}: ${describeError(error)}`);
        }
        await claimEvent(sql, event.id, handlerKey(handler));
      }
    },
    onDeadLetter: async (event) => {
      for (const handler of relevant(event)) {
        // A handler that finished its part has nothing left open; settling it would undo
        // completed work if its settlement is not guarded.
        if (await alreadyProcessed(sql, event.id, handlerKey(handler))) continue;
        await handler.onDeadLetter?.(event);
      }
    },
  };
}

export function handlerKey(handler: Pick<OutboxHandler, "name" | "version">): string {
  return `${handler.name}@${handler.version}`;
}

async function alreadyProcessed(
  sql: postgres.Sql,
  eventId: string,
  handlerVersion: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM core.inbox WHERE event_id = ${eventId} AND handler_version = ${handlerVersion}
  `;
  return rows.length > 0;
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
  readonly deadLettered: number;
}

/**
 * Unpublished backlog. Used by the operator screen and alerts.
 *
 * 06 §6.8: no hidden success on failure. If a growing backlog cannot be observed, nobody
 * knows events have stopped. Dead-lettered events are counted apart — they will not clear on
 * their own, and mixing them into "pending" would read as a delay.
 */
export async function backlogStats(sql: postgres.Sql): Promise<BacklogStats> {
  const [row] = await sql<{ pending: string; oldest: Date | null; dead: string }[]>`
    SELECT count(*) FILTER (WHERE dead_lettered_at IS NULL)::text AS pending,
           min(occurred_at) FILTER (WHERE dead_lettered_at IS NULL) AS oldest,
           count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead
    FROM core.outbox WHERE published_at IS NULL
  `;
  return {
    pending: Number(row?.pending ?? "0"),
    oldestPendingAt: row?.oldest ?? null,
    deadLettered: Number(row?.dead ?? "0"),
  };
}
