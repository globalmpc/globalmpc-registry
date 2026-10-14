import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { handlerKey, type OutboxHandler } from "./outbox-publisher.js";

/**
 * Outbox replay — 07 §7.5 "event replay requires a dry-run and a disable option per side
 * effect".
 *
 * Replay puts selected events back into the publishing queue. It does not call handlers itself:
 * the running loop picks the events up, so a replayed event takes the same path — inbox
 * deduplication, retry, dead-letter — as a new one.
 *
 * - **Dry run** reports, per event, which handler would run and which would be skipped
 *   (already processed at this handler version, or excluded). Nothing is written.
 * - **Skip** excludes handlers by name for the replayed events only. It is stored on the row,
 *   so the exclusion holds whichever worker process delivers the event.
 * - **Published events** are replayed only when asked. A handler that already processed an
 *   event at the same version still skips it; replaying published events is for a new handler
 *   version.
 *
 * Every applied replay writes one audit row per event. It changes what consumers will do, so
 * it is recorded like any other state change.
 */

export interface ReplaySelection {
  readonly eventIds?: readonly string[];
  readonly eventType?: string;
  /** Without this only dead-lettered events are selected. */
  readonly includePublished?: boolean;
  readonly limit: number;
}

export interface ReplayOptions {
  readonly dryRun: boolean;
  readonly skipHandlers: readonly string[];
  readonly reason: string;
}

export interface ReplayPlanItem {
  readonly eventId: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly status: "dead_lettered" | "published" | "pending";
  readonly handlers: readonly {
    readonly handler: string;
    readonly action: "run" | "already_processed" | "skipped";
  }[];
}

export interface ReplayResult {
  readonly dryRun: boolean;
  readonly items: readonly ReplayPlanItem[];
  readonly replayed: number;
}

interface SelectedRow {
  id: string;
  tenant_id: string;
  event_type: string;
  published_at: Date | null;
  dead_lettered_at: Date | null;
}

export class ReplayInputError extends Error {}

export function validateReplayInput(
  selection: ReplaySelection,
  options: ReplayOptions,
  handlers: readonly OutboxHandler[],
): void {
  // Replaying "everything" by omission is how a whole event history gets re-sent by accident.
  if ((selection.eventIds?.length ?? 0) === 0 && selection.eventType === undefined) {
    throw new ReplayInputError("Select events with --event-id or --event-type");
  }
  if (!Number.isInteger(selection.limit) || selection.limit < 1) {
    throw new ReplayInputError("--limit must be a positive integer");
  }
  const known = new Set(handlers.map((handler) => handler.name));
  const unknown = options.skipHandlers.filter((name) => !known.has(name));
  // A misspelled skip would otherwise run the very side effect the operator meant to suppress.
  if (unknown.length > 0) {
    throw new ReplayInputError(`Unknown handler(s): ${unknown.join(", ")}`);
  }
  if (!options.dryRun && options.reason.trim().length === 0) {
    throw new ReplayInputError("--reason is required when not a dry run");
  }
}

export async function replayEvents(
  sql: postgres.Sql,
  handlers: readonly OutboxHandler[],
  selection: ReplaySelection,
  options: ReplayOptions,
): Promise<ReplayResult> {
  validateReplayInput(selection, options, handlers);

  const ids = selection.eventIds ?? [];
  const rows = await sql<SelectedRow[]>`
    SELECT id, tenant_id, event_type, published_at, dead_lettered_at
    FROM core.outbox
    WHERE (${ids.length === 0} OR id = ANY(${ids as string[]}::uuid[]))
      AND (${selection.eventType ?? null}::text IS NULL OR event_type = ${selection.eventType ?? null})
      AND (
        dead_lettered_at IS NOT NULL
        OR (${selection.includePublished === true} AND published_at IS NOT NULL)
      )
    ORDER BY occurred_at, id
    LIMIT ${selection.limit}
  `;

  const items: ReplayPlanItem[] = [];
  for (const row of rows) {
    const processed = await sql<{ handler_version: string }[]>`
      SELECT handler_version FROM core.inbox WHERE event_id = ${row.id}
    `;
    const done = new Set(processed.map((entry) => entry.handler_version));

    items.push({
      eventId: row.id,
      tenantId: row.tenant_id,
      eventType: row.event_type,
      status: row.dead_lettered_at ? "dead_lettered" : row.published_at ? "published" : "pending",
      handlers: handlers
        .filter((handler) => handler.accepts(row.event_type))
        .map((handler) => ({
          handler: handler.name,
          action: options.skipHandlers.includes(handler.name)
            ? ("skipped" as const)
            : done.has(handlerKey(handler))
              ? ("already_processed" as const)
              : ("run" as const),
        })),
    });
  }

  if (options.dryRun || items.length === 0) {
    return { dryRun: options.dryRun, items, replayed: 0 };
  }

  const correlationId = `replay:${randomUUID()}`;
  await sql.begin(async (tx) => {
    for (const item of items) {
      await tx`
        UPDATE core.outbox
        SET published_at = NULL, dead_lettered_at = NULL, attempts = 0,
            next_attempt_at = NULL, last_error = NULL,
            skip_handlers = ${options.skipHandlers as string[]}, replayed_at = now()
        WHERE id = ${item.eventId}
      `;
      // No session: the operator runs this in the deployment environment. `deploy_bound`
      // says so rather than inventing an identity or a role decision (see apps/api audit.ts).
      await tx`
        INSERT INTO audit.events (
          tenant_id, effective_role, command, resource_type, resource_id,
          reason, correlation_id, detail
        ) VALUES (
          ${item.tenantId}, 'deploy_bound', 'outbox.event.replayed', 'outbox_event',
          ${item.eventId}, ${options.reason}, ${correlationId},
          ${tx.json({
            eventType: item.eventType,
            previousStatus: item.status,
            skipHandlers: [...options.skipHandlers],
          } as never)}
        )
      `;
    }
  });

  return { dryRun: false, items, replayed: items.length };
}
