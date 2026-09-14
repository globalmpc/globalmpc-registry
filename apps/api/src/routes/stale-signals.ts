import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requireMutationContext, requireReadContext } from "./shared.js";

/**
 * Evidence signals — spec 10 §175, AC-21.
 *
 * The last leg of propagation. `attestation → assessment → Registry version` cannot use the
 * same method as the earlier legs:
 *
 * - `compliance_assessments` is append-only.
 * - `registry_entry_versions` content is immutable after publishing.
 *
 * So instead of changing the target, **a signal is left.** An open signal means a re-review is
 * needed, not that the record is wrong — without that distinction, a source outage
 * becomes a denial of the record.
 *
 * **Nothing is revoked automatically.** Taking down a public Registry record changes what
 * the world sees, and if a public record disappeared because one connection broke, a source
 * outage would become record deletion.
 */

const resolveSchema = z.object({
  resolution: z.enum(["superseded", "revoked", "dismissed"]),
  note: z.string().min(1),
});

interface SignalRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly origin_attestation_id: string | null;
  readonly reason: string;
  readonly detected_at: Date;
  readonly resolution: string;
  readonly resolved_at: Date | null;
  readonly resolution_note: string | null;
}

/**
 * What can be done with this signal.
 *
 * If UIs guess from the state string, each UI reads it differently. In particular, the option
 * "take down the public record" must not be exposed silently.
 */
function nextActions(row: SignalRow): string[] {
  if (row.resolution !== "open") return [];

  if (row.target_type === "registry_entry_version") {
    return [
      "Correct with a new version (supersede)",
      "Take down the public record (revoke) — changes what the world sees",
      "Mark as no impact (dismiss) — the reason is recorded",
    ];
  }

  return ["Run a reassessment", "Mark as no impact (dismiss) — the reason is recorded"];
}

function toView(row: SignalRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    targetType: row.target_type,
    targetId: row.target_id,
    originAttestationId: row.origin_attestation_id,
    reason: row.reason,
    detectedAt: row.detected_at.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolutionNote: row.resolution_note,
    nextActions: nextActions(row),
  };
}

export async function registerStaleSignalRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/stale-signals",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );
      const { requestId, asOf } = request.context;

      const rows = await withTenant(
        sql,
        { tenantId },
        (tx) =>
          tx<SignalRow[]>`
          SELECT id, project_id, target_type::text AS target_type, target_id,
                 origin_attestation_id, reason, detected_at,
                 resolution::text AS resolution, resolved_at, resolution_note
          FROM core.evidence_stale_signals
          WHERE project_id = ${request.params.projectId}
          -- Open ones are shown first. Resolved ones are kept too — what was decided and how
          -- is evidence for the next decision.
          ORDER BY (resolution = 'open') DESC, detected_at DESC
        `,
      );

      return {
        items: rows.map(toView),
        openCount: rows.filter((row) => row.resolution === "open").length,
        requestId,
        asOf,
      };
    },
  );

  app.post<{ Params: { signalId: string } }>(
    "/api/v1/stale-signals/:signalId/resolve",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);

      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      /**
       * Requires the `registry.revoke` permission.
       *
       * Closing a signal declares "it has been decided what to do with this public record".
       * `dismissed` is the same — it is a decision to do nothing, and that too
       * decides the fate of the public record.
       */
      const effectiveRole = assertAuthorized(
        session,
        "registry.revoke",
        tenantResource(tenantId, { sensitivity: "public" }),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [current] = await tx<SignalRow[]>`
          SELECT id, project_id, target_type::text AS target_type, target_id,
                 origin_attestation_id, reason, detected_at,
                 resolution::text AS resolution, resolved_at, resolution_note
          FROM core.evidence_stale_signals
          WHERE id = ${request.params.signalId}
          FOR UPDATE
        `;
        if (!current) throw notFound("Signal not found");

        if (current.resolution !== "open") {
          throw conflict("SIGNAL_ALREADY_RESOLVED", `Already closed as ${current.resolution}`);
        }

        const [row] = await tx<SignalRow[]>`
          UPDATE core.evidence_stale_signals SET
            resolution = ${parsed.data.resolution},
            resolved_at = now(),
            resolved_by = ${session.subjectId},
            resolution_note = ${parsed.data.note}
          WHERE id = ${current.id}
          RETURNING id, project_id, target_type::text AS target_type, target_id,
                    origin_attestation_id, reason, detected_at,
                    resolution::text AS resolution, resolved_at, resolution_note
        `;

        /**
         * **Closing a signal does not change the target.**
         *
         * Even closed as `revoked`, the Registry version stays as is. Actually taking it down requires
         * a separate call to `registry-entries/{id}/revoke` — if one request did two things, it
         * would later be impossible to tell what was executed.
         */
        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          ...(current.project_id ? { projectId: current.project_id } : {}),
          session,
          command: "stale_signal.resolved",
          resourceType: "evidence_stale_signal",
          resourceId: current.id,
          correlationId,
          requestIp: request.ip,
          reason: parsed.data.note,
          detail: {
            resolution: parsed.data.resolution,
            targetType: current.target_type,
            targetId: current.target_id,
          },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "stale_signal.resolved",
          aggregateId: current.id,
          aggregateVersion: 1,
          ...(current.project_id ? { projectId: current.project_id } : {}),
          correlationId,
          payload: {
            resolution: parsed.data.resolution,
            targetType: current.target_type,
          },
        });

        return {
          ...toView(row!),
          // Closing does not mean the target changed. Said explicitly so the UI does not misread it.
          targetUnchanged: true,
          requestId,
          asOf,
        };
      });
    },
  );
}
