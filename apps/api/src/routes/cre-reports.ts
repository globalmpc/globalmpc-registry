import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { keccak256, toBytes } from "viem";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { createCreReportRequest, creReport } from "@mpc/api-contract";
import type { AppConfig } from "../config.js";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { requireMutationContext } from "./shared.js";
import { parseBody } from "./registry-drafts.js";
import { badRequest, notFound, unavailable } from "../errors.js";
import { recordAudit } from "../audit.js";
import { lockEvidenceLedgerPublicationInputs } from "../services/registry-publication.js";

/** An authenticated observation of approved public content, never an approval command. */
export async function registerCreReportRoutes(app: FastifyInstance, sql: postgres.Sql, config: AppConfig): Promise<void> {
  app.post<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/cre-reports", async request => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    parseBody(z.object({projectId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)}), request.params);
    const effectiveRole = assertAuthorized(session, "source.collect", projectResource(tenantId, request.params.projectId), sessionFacts(session));
    const body = parseBody(createCreReportRequest, request.body);
    if (body.chainId !== String(config.chainId)) throw badRequest("REQUEST_INVALID", "Report chain must match the configured chain");
    return withTenant(sql, { tenantId }, async tx => {
      // DON nodes may issue this exact request concurrently. Serialize reservations before
      // the standard idempotency helper reads/inserts, then take the project barrier.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'cre-report-key:' + tenantId + ':' + idempotencyKey},0))`;
      return withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
      // The same barrier used by publication prevents reporting a mixed evidence basis.
      const [project] = await tx`SELECT id FROM core.projects WHERE tenant_id=${tenantId} AND id=${request.params.projectId}`;
      if (!project) throw notFound("Published project record not found");
      await lockEvidenceLedgerPublicationInputs(tx, request.params.projectId);
      const [version] = await tx<{
        id: string; version: number; status: string; content_hash: string;
        public_projection: Record<string, unknown>; lifecycle_state: string;
      }[]>`
        SELECT v.id,v.version,v.status,v.content_hash,v.public_projection,p.lifecycle_state
        FROM core.registry_entries e JOIN core.registry_entry_versions v ON v.entry_id=e.id AND v.tenant_id=e.tenant_id
        JOIN core.projects p ON p.id=e.subject_id AND p.tenant_id=e.tenant_id
        WHERE e.tenant_id=${tenantId} AND e.subject_id=${request.params.projectId}
          AND e.registry_type='project' AND e.public_key=${body.publicKey}
          AND v.status IN ('published','revoked','superseded') AND v.published_at IS NOT NULL
        ORDER BY v.version DESC LIMIT 1 FOR SHARE OF v,p
      `;
      if (!version) throw notFound("Published project record not found");
      // Health must use a post-lock clock too: credentials may expire while a request waits.
      const [evaluation] = await tx<{ evaluated_at: string; observed_at: string }[]>`
        WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS evaluated_at)
        SELECT evaluated_at::text, floor(extract(epoch FROM evaluated_at))::bigint::text AS observed_at FROM clock
      `;
      if (!evaluation) throw new Error("Report health clock was not produced");
      const [health] = await tx<{ overlay: { warnings: unknown[] } | null; stale: boolean; unavailable: boolean; sequence: string }[]>`
        SELECT core.public_evidence_ledger_current(${version.id},${evaluation.evaluated_at}::text::timestamptz) AS overlay,
          -- Intentionally broader than the Explorer's per-item overlay: ANY open signal on this
          -- version marks the whole on-chain record stale. Item scoping must never weaken the
          -- record-level status reported on chain (fail closed).
          EXISTS (SELECT 1 FROM core.evidence_stale_signals signal
            WHERE signal.tenant_id=${tenantId} AND signal.project_id=${request.params.projectId}
              AND signal.target_type='registry_entry_version' AND signal.target_id=${version.id}
              AND signal.resolution='open') AS stale,
          EXISTS (
            SELECT 1 FROM core.evidence_ledger_snapshots snapshot
            CROSS JOIN LATERAL jsonb_array_elements(snapshot.snapshot->'items') item
            CROSS JOIN LATERAL jsonb_array_elements_text(item->'claimIds') claim_id
            JOIN core.claims c ON c.id::text=claim_id AND c.tenant_id=snapshot.tenant_id AND c.project_id=snapshot.project_id
            JOIN core.source_receipts receipt ON receipt.id=c.source_receipt_id AND receipt.tenant_id=c.tenant_id AND receipt.project_id=c.project_id
            JOIN core.source_connections connection ON connection.id=receipt.connection_id AND connection.tenant_id=receipt.tenant_id
            WHERE snapshot.tenant_id=${tenantId} AND snapshot.project_id=${request.params.projectId}
              AND snapshot.id::text=${version.public_projection["evidenceLedger"] && typeof version.public_projection["evidenceLedger"] === "object"
                ? (version.public_projection["evidenceLedger"] as Record<string, unknown>)["snapshotId"] as string : null}
              AND (connection.state <> 'active' OR (
                SELECT latest.outcome FROM core.source_observations latest
                WHERE latest.tenant_id=receipt.tenant_id AND latest.project_id=receipt.project_id
                  AND latest.connection_id=receipt.connection_id
                  AND latest.query_scope_hash=receipt.query_scope_hash
                  AND latest.query_basis=receipt.query_basis AND latest.outcome <> 'out_of_order'
                ORDER BY latest.observation_sequence DESC LIMIT 1
              ) IN ('unavailable','no_record'))
          ) AS unavailable,
          (SELECT (COALESCE((SELECT (history.report ->> 'sequence')::numeric FROM core.cre_reports history
            WHERE history.tenant_id=${tenantId} AND history.project_id=${request.params.projectId}
            ORDER BY ((history.report ->> 'sequence')::numeric) DESC LIMIT 1),0)+1)::text) AS sequence
      `;
      if (!health) throw new Error("Report observation was not produced");
      const projection = version.public_projection;
      // Live warnings cannot change the approved hash. Missing health evidence fails closed.
      const status = version.status === "revoked" ? 3
        : health.stale || version.status === "superseded" || version.lifecycle_state === "suspended"
          || projection["staleStatus"] === "stale" || (health.overlay?.warnings.length ?? 0) > 0 ? 2
        : !health.overlay || projection["staleStatus"] !== "fresh" || health.unavailable ? 5 : 1;
      // The report describes the exact health evaluation above, not a later transport time.
      // A slow assessment spends its own TTL; never relabel old health as a fresh observation.
      const [clock] = await tx<{ observed_at: string }[]>`
        SELECT floor(extract(epoch FROM clock_timestamp()))::bigint::text AS observed_at
      `;
      if (!clock) throw new Error("Report observation clock was not produced");
      const validUntil = BigInt(evaluation.observed_at) + BigInt(body.ttlSeconds);
      if (validUntil <= BigInt(clock.observed_at)) {
        throw unavailable("CRE_OBSERVATION_EXPIRED", "Health evaluation exceeded the observation TTL; retry to assess current health");
      }
      const report = creReport.parse({ chainId: body.chainId, receiver: body.receiver,
        recordId: keccak256(toBytes(`mpc-registry:project:${body.publicKey}`)), registryVersion: String(version.version),
        contentHash: version.content_hash, observedAt: evaluation.observed_at,
        validUntil: String(validUntil), sequence: health.sequence, status });
      const [stored] = await tx<{ id: string; report: typeof report }[]>`
        INSERT INTO core.cre_reports(tenant_id,project_id,registry_version_id,report)
        VALUES(${tenantId},${request.params.projectId},${version.id},${tx.json(report)}) RETURNING id,report
      `;
      await recordAudit(tx, { effectiveRole, tenantId, projectId: request.params.projectId, session,
        command: "cre_report.observed", resourceType: "cre_report", resourceId: stored!.id,
        correlationId: request.context.correlationId, requestIp: request.clientIp,
        detail: { recordId: report.recordId, sequence: report.sequence, status: report.status } });
      // PostgreSQL JSONB canonicalizes key order; use it for the initial response too,
      // so concurrent consensus nodes receive identical bytes on initial/replay paths.
      return stored!.report;
      });
    });
  });
}
