import type postgres from "postgres";

interface ObservationInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly connectionId: string;
  readonly receiptId: string;
  readonly queryBasis: Record<string, string>;
  readonly observedAt: Date;
  readonly result: string;
  readonly rawHash: string | null;
}

/** Called in the receipt transaction. Network failures never replace the successful baseline. */
export async function recordSourceObservation(
  tx: postgres.TransactionSql,
  input: ObservationInput,
): Promise<void> {
  const scope = tx.json(input.queryBasis);
  // Receipt inserts already acquire this project's publication barrier. Preserve that order
  // before serializing a query scope, including callers that use this service directly.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(
    'ledger-project:' || ${input.tenantId}::text || ':' || ${input.projectId}::text, 0))`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(
    'source-observation:' || ${input.tenantId}::text || ':' || ${input.projectId}::text
      || ':' || ${input.connectionId}::text || ':' || (${scope}::jsonb)::text, 0))`;
  let [previous] = await tx<{ receipt_id: string; raw_hash: string; observed_at: Date }[]>`
    SELECT o.receipt_id, r.raw_hash, o.observed_at
    FROM core.source_observations o JOIN core.source_receipts r ON r.id = o.receipt_id
    WHERE o.tenant_id = ${input.tenantId} AND o.project_id = ${input.projectId}
      AND o.connection_id = ${input.connectionId}
      AND o.query_scope_hash = md5((${scope}::jsonb)::text) AND o.query_basis = ${scope}::jsonb
      AND o.outcome IN ('baseline','unchanged','changed')
    ORDER BY o.observed_at DESC, o.observation_sequence DESC LIMIT 1
  `;
  if (!previous) {
    // Upgrade compatibility: receipts collected before observation tracking remain evidence.
    // The first scheduled collection must detect their changes, not silently reset history.
    [previous] = await tx<{ receipt_id: string; raw_hash: string; observed_at: Date }[]>`
      SELECT r.id AS receipt_id, r.raw_hash, r.received_at AS observed_at
      FROM core.source_receipts r
      WHERE r.tenant_id=${input.tenantId} AND r.project_id=${input.projectId}
        AND r.connection_id=${input.connectionId}
        AND r.query_scope_hash=md5((${scope}::jsonb)::text) AND r.query_basis=${scope}::jsonb
        AND r.id<>${input.receiptId} AND r.result='confirmed_from_source'
        AND r.raw_hash IS NOT NULL AND r.channel_evidence->>'collector'='server_adapter'
        AND NOT EXISTS (SELECT 1 FROM core.source_observations o WHERE o.receipt_id=r.id)
        AND r.received_at <= (SELECT received_at FROM core.source_receipts WHERE id=${input.receiptId})
      ORDER BY r.received_at DESC, r.id DESC LIMIT 1
    `;
  }
  const [latest] = await tx<{ observed_at: Date }[]>`
    SELECT observed_at FROM core.source_observations
    WHERE tenant_id=${input.tenantId} AND project_id=${input.projectId}
      AND connection_id=${input.connectionId}
      AND query_scope_hash=md5((${scope}::jsonb)::text) AND query_basis=${scope}::jsonb
      AND outcome <> 'out_of_order'
    ORDER BY observed_at DESC,observation_sequence DESC LIMIT 1
  `;
  const outOfOrder = (latest && input.observedAt < latest.observed_at)
    || (previous && input.observedAt < previous.observed_at);
  let outcome = input.result === "source_returned_no_record" ? "no_record" : "unavailable";
  let affected: string[] = [];
  if (input.result === "confirmed_from_source" && input.rawHash !== null) {
    outcome = !previous ? "baseline"
      : input.observedAt < previous.observed_at ? "out_of_order"
      : input.rawHash === previous.raw_hash ? "unchanged" : "changed";
  }
  if (outOfOrder) outcome = "out_of_order";
  if (outcome === "changed" || (outcome === "no_record" && previous
      && input.observedAt >= previous.observed_at)) {
    // A recognized missing record needs review, never automatic revocation. Failures do not
    // enter this branch. Compare all older bound receipts, including an unchanged sequence.
    const reason = outcome === "no_record"
      ? `Official source returned no record; review observation receipt ${input.receiptId}`
      : `Official source response changed; review observation receipt ${input.receiptId}`;
    const rows = await tx<{ id: string }[]>`
      UPDATE core.claims c SET stale_since = now(), stale_reason = ${reason}
      FROM core.source_receipts r
      WHERE c.tenant_id = ${input.tenantId} AND c.project_id = ${input.projectId}
        AND c.source_receipt_id = r.id AND r.tenant_id = ${input.tenantId}
        AND r.project_id = ${input.projectId} AND r.connection_id = ${input.connectionId}
        AND r.query_basis = ${scope}::jsonb AND r.id <> ${input.receiptId}
        AND (${outcome === "no_record"} OR r.raw_hash IS DISTINCT FROM ${input.rawHash})
        AND r.received_at <= (SELECT received_at FROM core.source_receipts WHERE id = ${input.receiptId})
        AND c.stale_since IS NULL
      RETURNING c.id
    `;
    affected = rows.map((row) => row.id);
  }
  await tx`
    INSERT INTO core.source_observations
      (tenant_id,project_id,connection_id,receipt_id,previous_receipt_id,query_basis,
       observed_at,outcome,affected_claim_ids)
    VALUES (${input.tenantId},${input.projectId},${input.connectionId},${input.receiptId},
      ${previous?.receipt_id ?? null},${scope}::jsonb,${input.observedAt},${outcome},${affected})
  `;
}
