-- Unauthenticated public read — spec 07 §7.1, OD-02.
--
-- **Why:** the Public Explorer does not know the tenant, because readers are not
-- logged in. But `registry_entry_versions` has RLS and the policy requires
-- `tenant_id = core.current_tenant()`, so public reads always get 0 rows.
--
-- Same problem as session resolution, same fix — only the public path is split into
-- SECURITY DEFINER functions.
--
-- **Security boundary:**
--
-- 1. Returns only `status IN ('published','revoked','superseded')`. Drafts never
--    leave.
-- 2. Returns only the `public_projection` column. Internal fields such as
--    `source_snapshot_hash` are not exposed.
-- 3. Does not return tenant_id. The owning tenant cannot be determined.
-- 4. `search_path` is pinned to prevent function hijacking.

CREATE FUNCTION core.public_registry_versions(p_registry_type TEXT, p_public_key TEXT)
RETURNS TABLE (
  id                UUID,
  public_projection JSONB,
  version           INTEGER,
  status            core.registry_entry_status,
  published_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  superseded_by_id  UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT v.id, v.public_projection, v.version, v.status,
         v.published_at, v.revoked_at, v.superseded_by_id
  FROM core.registry_entry_versions v
  JOIN core.registry_entries e ON e.id = v.entry_id
  WHERE e.registry_type = p_registry_type::core.registry_type
    AND e.public_key = p_public_key
    AND v.status IN ('published', 'revoked', 'superseded')
    AND v.public_projection IS NOT NULL
  ORDER BY v.version DESC
$$;

-- Inclusion proofs are also readable without auth (OD-02: proofs are login-free read-only).
CREATE FUNCTION core.public_inclusion_proof(p_entry_version_id UUID)
RETURNS TABLE (
  leaf_hash          TEXT,
  batch_row_id       UUID,
  merkle_root        TEXT,
  external_batch_id  TEXT,
  transaction_state  TEXT,
  transaction_hash   TEXT,
  block_number       BIGINT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT l.leaf_hash, l.batch_id, b.merkle_root, b.batch_id,
         t.state::text, t.tx_hash, t.block_number
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  LEFT JOIN LATERAL (
    SELECT state, tx_hash, block_number FROM chain.transactions
    WHERE batch_id = b.id ORDER BY created_at DESC LIMIT 1
  ) t ON true
  WHERE l.entry_version_id = p_entry_version_id
    -- No proof is served for an unpublished version.
    AND v.status IN ('published', 'revoked', 'superseded')
$$;

CREATE FUNCTION core.public_batch_leaves(p_batch_row_id UUID)
RETURNS TABLE (leaf_hash TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = chain, pg_temp
AS $$
  SELECT leaf_hash FROM chain.anchor_batch_leaves WHERE batch_id = p_batch_row_id
$$;

REVOKE EXECUTE ON FUNCTION core.public_registry_versions(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_batch_leaves(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.public_registry_versions(TEXT, TEXT) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_batch_leaves(UUID) TO mpc_app;
