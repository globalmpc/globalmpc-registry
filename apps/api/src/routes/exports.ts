import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { auditExportQuery } from "@mpc/api-contract";
import { recordAudit } from "../audit.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { requireMutationContext, requireReadContext } from "./shared.js";

/**
 * Exports — spec 07 §7.9, 12 §12.4.
 *
 * - `GET /audit-events/export` — the audit trail as JSON Lines plus a sha256 manifest, so a
 *   reviewer can hold a copy and later show it was not altered. The export is itself recorded.
 * - `POST /projects/{id}/exports` — an asynchronous package job. The outbox worker builds it
 *   (`apps/jobs-worker/src/project-export.ts`); this route only records the request, the requester's
 *   clearance, and the event, in one transaction.
 */

const uuid = z.string().uuid();

interface AuditRow {
  id: string;
  occurred_at: Date;
  project_id: string | null;
  actor_subject_id: string | null;
  actor_wallet: string | null;
  effective_role: string | null;
  command: string;
  resource_type: string;
  resource_id: string | null;
  before_version: number | null;
  after_version: number | null;
  reason: string | null;
  correlation_id: string;
  signature_or_tx: string | null;
}

interface ExportRow {
  id: string;
  project_id: string;
  requested_by_subject_id: string;
  sensitivity_clearance: string[];
  state: "queued" | "succeeded" | "failed";
  package: Record<string, unknown> | null;
  manifest_hash: string | null;
  failure_reason: string | null;
  requested_at: Date;
  completed_at: Date | null;
}

function toExportView(row: ExportRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    state: row.state,
    requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    sensitivityClearance: row.sensitivity_clearance,
    manifestHash: row.manifest_hash,
    failureReason: row.failure_reason,
    package: row.package,
  };
}

export async function registerExportRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/audit-events/export", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "audit.export",
      tenantResource(tenantId),
      sessionFacts(session),
    );

    const parsed = auditExportQuery.safeParse(request.query);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Query parameters are invalid", {
        issues: parsed.error.issues,
      });
    }
    const { projectId, from, to, afterId, limit } = parsed.data;
    const { requestId, asOf, correlationId } = request.context;

    return withTenant(sql, { tenantId }, async (tx) => {
      // One row past the page tells whether another page exists without a count query.
      const rows = await tx<AuditRow[]>`
        SELECT id::text, occurred_at, project_id, actor_subject_id, actor_wallet, effective_role,
               command, resource_type, resource_id, before_version, after_version, reason,
               correlation_id, signature_or_tx
        FROM audit.events
        WHERE tenant_id = ${tenantId}
          AND (${projectId ?? null}::uuid IS NULL OR project_id = ${projectId ?? null})
          AND (${from ?? null}::timestamptz IS NULL OR occurred_at >= ${from ?? null})
          AND (${to ?? null}::timestamptz IS NULL OR occurred_at < ${to ?? null})
          AND (${afterId ?? null}::bigint IS NULL OR id > ${afterId ?? null}::bigint)
        ORDER BY id
        LIMIT ${limit + 1}
      `;

      const page = rows.slice(0, limit);
      // Key order is fixed by this literal, so the same rows always hash the same.
      const jsonl = page
        .map(
          (row) =>
            `${JSON.stringify({
              id: row.id,
              occurredAt: row.occurred_at.toISOString(),
              projectId: row.project_id,
              actorSubjectId: row.actor_subject_id,
              actorWallet: row.actor_wallet,
              effectiveRole: row.effective_role,
              command: row.command,
              resourceType: row.resource_type,
              resourceId: row.resource_id,
              beforeVersion: row.before_version,
              afterVersion: row.after_version,
              reason: row.reason,
              correlationId: row.correlation_id,
              signatureOrTx: row.signature_or_tx,
            })}\n`,
        )
        .join("");

      const manifest = {
        format: "mpc.audit-export" as const,
        formatVersion: "1" as const,
        encoding: "application/x-ndjson" as const,
        hashAlgorithm: "sha256" as const,
        sha256: createHash("sha256").update(jsonl, "utf8").digest("hex"),
        lineCount: page.length,
        firstId: page[0]?.id ?? null,
        lastId: page.at(-1)?.id ?? null,
        nextAfterId: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
        filters: {
          projectId: projectId ?? null,
          from: from ?? null,
          to: to ?? null,
          afterId: afterId ?? null,
        },
        generatedAt: asOf,
        generatedBy: session.walletAddress,
      };

      // Who took a copy of the trail, and which copy, is part of the trail (07 §7.9). The hash
      // lets a later reader tie a file in hand to this row.
      await recordAudit(tx, {
        tenantId,
        ...(projectId ? { projectId } : {}),
        session,
        effectiveRole,
        command: "audit.exported",
        resourceType: "audit_export",
        correlationId,
        requestIp: request.clientIp,
        detail: {
          filters: manifest.filters,
          lineCount: manifest.lineCount,
          sha256: manifest.sha256,
        },
      });

      return { manifest, jsonl, requestId, asOf };
    });
  });

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/exports",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const { projectId } = request.params;
      if (!uuid.safeParse(projectId).success) throw notFound("Project not found");

      const facts = sessionFacts(session);
      const effectiveRole = assertAuthorized(
        session,
        "project.export",
        projectResource(tenantId, projectId),
        facts,
      );

      // The job names who asked; a package with no requester could be read by no one.
      const subjectId = session.subjectId;
      if (subjectId === null) {
        throw forbidden("SUBJECT_REQUIRED", "Exports need a wallet bound to a person");
      }

      const { requestId, asOf, correlationId } = request.context;
      // The requester and the project path are part of the hash: the same key from another
      // person is a different request, refused as a reuse rather than answered with someone
      // else's job. The body is not read, so it is not hashed either.
      const requestHash = hashRequest(request, null);

      const result = await withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [project] = await tx<{ id: string }[]>`
            SELECT id FROM core.projects WHERE id = ${projectId}
          `;
          if (!project) throw notFound("Project not found");

          const id = randomUUID();
          const [row] = await tx<ExportRow[]>`
            INSERT INTO core.project_exports (
              id, tenant_id, project_id, requested_by_subject_id, requested_by_wallet,
              sensitivity_clearance
            ) VALUES (
              ${id}, ${tenantId}, ${projectId}, ${subjectId}, ${session.walletAddress},
              ${facts.sensitivityClearance as string[]}
            )
            RETURNING id, project_id, requested_by_subject_id, sensitivity_clearance, state,
                      package, manifest_hash, failure_reason, requested_at, completed_at
          `;

          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.export.requested",
            aggregateId: id,
            aggregateVersion: 1,
            projectId,
            payload: { exportId: id, projectId },
            correlationId,
          });

          await recordAudit(tx, {
            tenantId,
            projectId,
            session,
            effectiveRole,
            command: "project.export.requested",
            resourceType: "project_export",
            resourceId: id,
            correlationId,
            requestIp: request.clientIp,
            detail: { sensitivityClearance: facts.sensitivityClearance },
          });

          return toExportView(row!);
        }),
      );

      // Accepted, not done: the package is built by the worker.
      return reply.code(202).send({ ...result, requestId, asOf });
    },
  );

  app.get<{ Params: { projectId: string; exportId: string } }>(
    "/api/v1/projects/:projectId/exports/:exportId",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { projectId, exportId } = request.params;
      if (!uuid.safeParse(projectId).success || !uuid.safeParse(exportId).success) {
        throw notFound("Export not found");
      }

      assertAuthorized(
        session,
        "project.export",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const [row] = await withTenant(sql, { tenantId }, (tx) =>
        tx<ExportRow[]>`
          SELECT id, project_id, requested_by_subject_id, sensitivity_clearance, state,
                 package, manifest_hash, failure_reason, requested_at, completed_at
          FROM core.project_exports
          WHERE id = ${exportId} AND project_id = ${projectId}
        `,
      );

      /**
       * Only the requester reads a package. It was redacted to their clearance; handing it to
       * someone else would show them what their own clearance hides. Someone else's job answers
       * exactly like a missing one.
       */
      if (!row || row.requested_by_subject_id !== session.subjectId) {
        throw notFound("Export not found");
      }

      return { ...toExportView(row), requestId: request.context.requestId, asOf: request.context.asOf };
    },
  );
}
