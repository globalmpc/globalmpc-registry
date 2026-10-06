-- Public hash lookup.
--
-- Whatever a visitor brings — a transaction hash seen on BscScan, a certificate's Merkle root·leaf
-- hash, or a batch id — answers **which public records are in it**.
-- Until now public lookup required already knowing the registry key.
--
-- Boundary (same as 0009):
--
-- 1. Only published versions (`published`·`revoked`·`superseded`). Even if the same batch
--    mixes in leaves in other states, those are not exposed.
-- 2. Does not return tenant_id·submitter·address. Anchor leaves carry no submitter
--    address (services/anchor-batch.ts), and none is attached here.
-- 3. Input is exact match only. Partial-match hash search becomes a path for probing
--    existence one character at a time.

CREATE FUNCTION core.public_hash_lookup(p_hash TEXT)
RETURNS TABLE (
  matched_on        TEXT,
  registry_type     TEXT,
  public_key        TEXT,
  entry_version_id  UUID,
  version           INTEGER,
  status            TEXT,
  merkle_root       TEXT,
  transaction_hash  TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT CASE
           WHEN l.leaf_hash = p_hash THEN 'leaf_hash'
           WHEN b.merkle_root = p_hash THEN 'merkle_root'
           WHEN b.batch_id = p_hash THEN 'batch_id'
           ELSE 'transaction_hash'
         END,
         e.registry_type::text,
         e.public_key,
         v.id,
         v.version,
         v.status::text,
         b.merkle_root,
         latest_tx.tx_hash
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  JOIN core.registry_entries e ON e.id = v.entry_id
  -- Displays the most recent submission. Lookups by a replaced earlier tx hash reach the same batch.
  LEFT JOIN LATERAL (
    SELECT t.tx_hash FROM chain.transactions t
    WHERE t.batch_id = b.id ORDER BY t.created_at DESC LIMIT 1
  ) latest_tx ON true
  WHERE (
          l.leaf_hash = p_hash
       OR b.merkle_root = p_hash
       OR b.batch_id = p_hash
       OR EXISTS (
            SELECT 1 FROM chain.transactions t
            WHERE t.batch_id = b.id AND t.tx_hash = p_hash
          )
        )
    AND v.status IN ('published', 'revoked', 'superseded')
    AND v.public_projection IS NOT NULL
  ORDER BY e.public_key, v.version DESC
  LIMIT 50
$$;

REVOKE EXECUTE ON FUNCTION core.public_hash_lookup(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_hash_lookup(TEXT) TO mpc_app;
