-- Carries spec versions in the inclusion proof.
--
-- **Problem:** a proof says "these bytes were in this batch", but not **which spec the verifier
-- must use to rebuild** those bytes. A leaf is built by
-- canonical serialization, and that spec is versioned. Without the version,
-- reconstruction is not reproducible, and a non-reproducible proof becomes "trust me".
--
-- **Decision (2026-09-09, user instruction): carry only three non-identifying version strings.**
--
-- `policy_version` · `schema_version` · `serialization_version`. All three name
-- specs and **identify no subject.** This is not about carrying the leaf's raw content or
-- `subject_id` — that is a separate decision and is not made
-- here (D-41).
--
-- The route **emitted `serialization_version` as a hardcoded `"1"`.** The column
-- defaults to `'1'`, so they matched so far, but once the spec is bumped (CLAUDE.md — bump the
-- version to reproduce already-anchored roots) only the response keeps reporting the old value.
-- Emitting the stored value as is prevents that incident.

DROP FUNCTION IF EXISTS core.public_inclusion_proof(UUID);

CREATE FUNCTION core.public_inclusion_proof(p_entry_version_id UUID)
RETURNS TABLE (
  leaf_hash             TEXT,
  batch_row_id          UUID,
  merkle_root           TEXT,
  external_batch_id     TEXT,
  transaction_state     TEXT,
  transaction_hash      TEXT,
  block_number          BIGINT,
  policy_version        TEXT,
  schema_version        TEXT,
  serialization_version TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT l.leaf_hash, l.batch_id, b.merkle_root, b.batch_id,
         t.state::text, t.tx_hash, t.block_number,
         v.policy_version, v.schema_version, v.serialization_version
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  LEFT JOIN LATERAL (
    SELECT state, tx_hash, block_number FROM chain.transactions
    WHERE batch_id = b.id ORDER BY created_at DESC LIMIT 1
  ) t ON true
  WHERE l.entry_version_id = p_entry_version_id
    -- Proofs are not provided for unpublished versions.
    AND v.status IN ('published', 'revoked', 'superseded')
$$;

REVOKE EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) TO mpc_app;
