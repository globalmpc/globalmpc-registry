import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { resolveReconciliationTaskRequest } from "@mpc/api-contract";
import { badRequest, conflict, notFound } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Source reconciliation and stage evidence — spec 04 §4.9, AC-19, 12 §12.13 R5 gate item 8.
 *
 * A degrading source result takes the connection to `degraded` and opens a task (migration
 * 0060). Collection stays paused until the task is resolved **and** someone moves the connection
 * back to `active` — two separate decisions, so that "the source answered again" is never
 * mistaken for "we checked why it broke".
 */

interface TaskRow {
  readonly id: string;
  readonly connection_id: string;
  readonly receipt_id: string;
  readonly trigger_result: string;
  readonly state: "open" | "resolved";
  readonly opened_at: Date;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly resolution: string | null;
  readonly version: number;
}

function toTaskView(row: TaskRow) {
  return {
    taskId: row.id,
    connectionId: row.connection_id,
    receiptId: row.receipt_id,
    triggerResult: row.trigger_result,
    state: row.state,
    openedAt: row.opened_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedBy: row.resolved_by,
    resolution: row.resolution,
    version: row.version,
  };
}

const TASK_COLUMNS = `
  id, connection_id, receipt_id, trigger_result::text AS trigger_result, state, opened_at,
  resolved_at, resolved_by, resolution, version
`;

export async function registerSourceReconciliationRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get<{ Params: { connectionId: string } }>(
    "/api/v1/source-connections/:connectionId/reconciliation-tasks",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      assertAuthorized(session, "authority.read", tenantResource(tenantId), sessionFacts(session));

      const { requestId, asOf } = request.context;
      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<TaskRow[]>`
          SELECT ${tx.unsafe(TASK_COLUMNS)}
          FROM core.source_reconciliation_tasks
          WHERE connection_id = ${request.params.connectionId}
          ORDER BY opened_at DESC, id
        `,
      );

      return { items: rows.map(toTaskView), requestId, asOf };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/v1/source-reconciliation-tasks/:taskId/resolve",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expected = requireIfMatch(request);

      const parsed = resolveReconciliationTaskRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "connection.configure",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const result = await withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [current] = await tx<TaskRow[]>`
            SELECT ${tx.unsafe(TASK_COLUMNS)}
            FROM core.source_reconciliation_tasks
            WHERE id = ${request.params.taskId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Reconciliation task not found");
          assertVersionMatches(expected, current.version, "source_reconciliation_task");

          if (current.state === "resolved") {
            throw conflict("RECONCILIATION_ALREADY_RESOLVED", "This task is already resolved");
          }

          const [row] = await tx<TaskRow[]>`
            UPDATE core.source_reconciliation_tasks SET
              state = 'resolved', resolved_at = now(), resolved_by = ${session.subjectId},
              resolution = ${parsed.data.resolution}, version = version + 1
            WHERE id = ${current.id}
            RETURNING ${tx.unsafe(TASK_COLUMNS)}
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "source_reconciliation.resolved",
            resourceType: "source_reconciliation_task",
            resourceId: current.id,
            correlationId,
            requestIp: request.clientIp,
            reason: parsed.data.resolution,
            beforeVersion: current.version,
            afterVersion: row!.version,
            detail: { connectionId: current.connection_id, triggerResult: current.trigger_result },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "evidence_adapter.reconciled",
            aggregateId: current.connection_id,
            aggregateVersion: row!.version,
            correlationId,
            payload: { taskId: current.id, triggerResult: current.trigger_result },
          });

          return toTaskView(row!);
        }),
      );

      reply.header("etag", etagOf(result.version));
      return { ...result, requestId, asOf };
    },
  );

  /**
   * Stage history — evidence for R5 gate item 8.
   *
   * Includes changes nobody requested through the API (authority approval withdrawn, a degrading
   * receipt). Those carry the reason the trigger recorded and no actor.
   */
  app.get<{ Params: { connectionId: string } }>(
    "/api/v1/source-connections/:connectionId/transitions",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      assertAuthorized(session, "authority.read", tenantResource(tenantId), sessionFacts(session));

      const { requestId, asOf } = request.context;
      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<
          {
            from_state: string | null;
            to_state: string;
            actor_subject_id: string | null;
            reason: string;
            occurred_at: Date;
          }[]
        >`
          SELECT from_state::text AS from_state, to_state::text AS to_state,
                 actor_subject_id, reason, occurred_at
          FROM core.source_connection_transitions
          WHERE connection_id = ${request.params.connectionId}
          ORDER BY occurred_at, id
        `,
      );

      return {
        items: rows.map((row) => ({
          fromState: row.from_state,
          toState: row.to_state,
          actorSubjectId: row.actor_subject_id,
          reason: row.reason,
          occurredAt: row.occurred_at.toISOString(),
        })),
        requestId,
        asOf,
      };
    },
  );
}
