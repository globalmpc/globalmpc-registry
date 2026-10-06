import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { myActivityQuery } from "@mpc/api-contract";
import { badRequest } from "../errors.js";
import {
  assertAuthorized,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { requireReadContext } from "./shared.js";

/**
 * Observability routes — spec 02 §2.6, 07 §7.5.
 *
 * The guarantee that `audit.events` is append-only and not modifiable even by a superuser is
 * useless to operations without a read path. An audit trail visible only through a direct DB
 * connection undermines trust in the audit.
 *
 * Two rules hold.
 *
 * - **`detail` is not exposed as-is.** Event payloads are agreed to carry no PII, but if that
 *   promise breaks, this screen becomes the first leak path.
 * - **Reading also requires permission.** Only auditor·security_operator·mpc_operator hold
 *   `audit.read`. Who did what is not for everyone to see.
 */

const auditQuerySchema = z.object({
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  command: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerObservabilityRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * My activity.
   *
   * Returns only mutations made by the subject bound to this wallet. **The missing role check is
   * intentional** — these are the caller's own records, not someone else's. The question differs
   * from the tenant-wide audit trail (`audit.read`): that one asks "what happened here", this one
   * asks "what did I do".
   */
  app.get("/api/v1/me/activity", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    const parsed = myActivityQuery.safeParse(request.query);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Query parameters are invalid", {
        issues: parsed.error.issues,
      });
    }

    const { limit, cursor } = parsed.data;
    const { requestId, asOf } = request.context;
    // A wallet without a subject cannot have recorded actions. That is an empty list, not an error.
    if (session.subjectId === null) return { items: [], nextCursor: null, requestId, asOf };
    const subjectId = session.subjectId;

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<
        {
          id: string;
          occurred_at: Date;
          command: string;
          resource_type: string;
          resource_id: string | null;
          project_id: string | null;
          effective_role: string | null;
          reason: string | null;
          signature_or_tx: string | null;
        }[]
      >`
        SELECT id::text, occurred_at, command, resource_type, resource_id, project_id,
               effective_role, reason, signature_or_tx
        FROM audit.events
        WHERE tenant_id = ${tenantId}
          AND actor_subject_id = ${subjectId}
          AND (${cursor ?? null}::bigint IS NULL OR id < ${cursor ?? null}::bigint)
        ORDER BY id DESC
        LIMIT ${limit + 1}
      `,
    );

    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        command: row.command,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        projectId: row.project_id,
        effectiveRole: row.effective_role,
        reason: row.reason,
        signatureOrTx: row.signature_or_tx,
      })),
      // id is a BIGSERIAL and increases monotonically, so it serves as the keyset itself.
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      requestId,
      asOf,
    };
  });

  app.get("/api/v1/audit-events", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    assertAuthorized(session, "audit.read", tenantResource(tenantId), sessionFacts(session));

    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Query parameters are invalid", {
        issues: parsed.error.issues,
      });
    }

    const { resourceType, resourceId, projectId, command, limit } = parsed.data;
    const { requestId, asOf } = request.context;

    const rows = await withTenant(
      sql,
      { tenantId },
      (tx) =>
        tx<
          {
            id: string;
            occurred_at: Date;
            command: string;
            resource_type: string;
            resource_id: string | null;
            actor_wallet: string | null;
            effective_role: string | null;
            before_version: number | null;
            after_version: number | null;
            reason: string | null;
            correlation_id: string;
            project_id: string | null;
          }[]
        >`
        SELECT id::text, occurred_at, command, resource_type, resource_id,
               actor_wallet, effective_role, before_version, after_version,
               reason, correlation_id, project_id
        FROM audit.events
        WHERE tenant_id = ${tenantId}
          AND (${resourceType ?? null}::text IS NULL OR resource_type = ${resourceType ?? null})
          AND (${resourceId ?? null}::uuid IS NULL OR resource_id = ${resourceId ?? null})
          AND (${projectId ?? null}::uuid IS NULL OR project_id = ${projectId ?? null})
          AND (${command ?? null}::text IS NULL OR command = ${command ?? null})
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${limit}
      `,
    );

    return {
      // detail is not exposed. command and resource are enough to say what happened.
      items: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        command: row.command,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        actorWallet: row.actor_wallet,
        effectiveRole: row.effective_role,
        beforeVersion: row.before_version,
        afterVersion: row.after_version,
        reason: row.reason,
        correlationId: row.correlation_id,
        projectId: row.project_id,
      })),
      requestId,
      asOf,
    };
  });

  /**
   * Event publishing backlog.
   *
   * The outbox is at-least-once. A backlog means events are **delayed**, not lost — that
   * distinction decides the response. Mistaking delay for loss leads to manual re-creation,
   * which produces real duplicates.
   */
  app.get("/api/v1/outbox-backlog", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    assertAuthorized(session, "audit.read", tenantResource(tenantId), sessionFacts(session));

    const { requestId, asOf } = request.context;

    return withTenant(sql, { tenantId }, async (tx) => {
      const [summary] = await tx<
        { pending: string; oldest: Date | null; published_last_hour: string }[]
      >`
        SELECT
          count(*) FILTER (WHERE published_at IS NULL)::text AS pending,
          min(occurred_at) FILTER (WHERE published_at IS NULL) AS oldest,
          count(*) FILTER (WHERE published_at >= now() - interval '1 hour')::text
            AS published_last_hour
        FROM core.outbox
      `;

      const byType = await tx<{ event_type: string; pending: string }[]>`
        SELECT event_type, count(*)::text AS pending
        FROM core.outbox WHERE published_at IS NULL
        GROUP BY event_type ORDER BY count(*) DESC
      `;

      const oldest = summary?.oldest ?? null;

      return {
        pending: Number(summary?.pending ?? "0"),
        oldestPendingAt: oldest?.toISOString() ?? null,
        // Delay matters more than count. 1000 events 1 second late and 1 event an hour late
        // are different problems.
        oldestPendingAgeSeconds: oldest ? Math.floor((Date.now() - oldest.getTime()) / 1000) : null,
        publishedLastHour: Number(summary?.published_last_hour ?? "0"),
        byEventType: byType.map((row) => ({
          eventType: row.event_type,
          pending: Number(row.pending),
        })),
        requestId,
        asOf,
      };
    });
  });
}
