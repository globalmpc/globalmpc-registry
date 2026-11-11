import type postgres from "postgres";
import { projectStageProgress, type ProjectStageProgress } from "@mpc/api-contract";

/** Caller supplies only authorized, capped project IDs within the active tenant transaction. */
export async function savedProjectProgress(tx: postgres.TransactionSql, tenantId: string, projectIds: string[]) {
  const result = new Map<string, ProjectStageProgress>();
  if (!projectIds.length) return result;
  // Indexed lookup per capped ID, in one round trip. Do not scan every historical snapshot
  // or compute a ledger when a list is opened. The snapshot creation time determines latest.
  const rows = await tx<{project_id: string; summary: unknown}[]>`
    SELECT p.id AS project_id, jsonb_build_object(
      'evaluatedAt', s.snapshot->'evaluatedAt',
      'currentStage', s.snapshot->'currentStage',
      'stages', s.snapshot->'stages'
    ) AS summary
    FROM unnest(${projectIds}::uuid[]) AS p(id)
    CROSS JOIN LATERAL (
      SELECT snapshot FROM core.evidence_ledger_snapshots
      WHERE tenant_id = ${tenantId} AND project_id = p.id
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) s
  `;
  for (const row of rows) {
    // Strip unlisted fields (including policy IDs). Invalid historical data is unavailable,
    // never an excuse to evaluate all rows or fall back to an older passing assessment.
    const parsed = projectStageProgress.safeParse(row.summary);
    if (parsed.success) result.set(row.project_id, parsed.data);
  }
  return result;
}
