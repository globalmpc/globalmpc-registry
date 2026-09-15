-- Anchor worker integrity — spec 06 §6.8, 08 §8.9, O1
--
-- Four changes, each closing a silent stall or a silent drift in the anchor path.
--
-- 1. `anchor_proposals.checked_at` — the worker now reads back every open Safe proposal, not
--    only the oldest. The Safe Transaction Service is external and rate-limited, so each proposal
--    is asked about at most once per recheck interval; this column records when it last was.
-- 2. One batch per registry version. Two concurrent batch requests read the same unanchored
--    versions and each anchored them — one version in two roots, and its inclusion ambiguous.
-- 3. `chain.gas_spend` — gas ledger for the daily spend cap (O1). The cap summed the gas columns
--    of `chain.transactions`, which hold the latest attempt only: a resubmission clears the row
--    and the next receipt overwrites it, so earlier attempts dropped out of the day's total.
-- 4. Gauge for the oldest open Safe proposal. `proposed` is not a failure state, so no alert saw
--    a proposal nobody signs.

-- ---------------------------------------------------------------------------
-- 1. Proposal read-back time
-- ---------------------------------------------------------------------------

ALTER TABLE chain.anchor_proposals ADD COLUMN checked_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. A version is anchored in at most one batch
--
-- The batch route also serializes batch creation per tenant; this index is what holds when any
-- other writer — or a future route — skips that. Fails if duplicates already exist: those batches
-- are on chain and cannot be rewritten, so an operator decides, not this migration.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX anchor_batch_leaves_entry_version_idx
  ON chain.anchor_batch_leaves (entry_version_id);

-- ---------------------------------------------------------------------------
-- 3. Gas ledger
--
-- One row per mined transaction hash. Seeing the same hash again (a recheck, a reorg that re-mines
-- it) does not count it twice; a new attempt with a new hash adds a row instead of replacing one.
-- Append-only: the worker gets SELECT and INSERT, nothing else.
-- ---------------------------------------------------------------------------

CREATE TABLE chain.gas_spend (
  chain_id            INTEGER NOT NULL,
  tx_hash             TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_id      UUID NOT NULL REFERENCES chain.transactions(id),
  tenant_id           UUID NOT NULL REFERENCES core.tenants(id),
  gas_used            NUMERIC(78, 0) NOT NULL CHECK (gas_used >= 0),
  effective_gas_price NUMERIC(78, 0) NOT NULL CHECK (effective_gas_price >= 0),
  -- When the receipt was first seen. The daily cap counts by this time (UTC day).
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, tx_hash)
);

CREATE INDEX gas_spend_day_idx ON chain.gas_spend (chain_id, observed_at);

ALTER TABLE chain.gas_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.gas_spend FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chain.gas_spend
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON chain.gas_spend TO mpc_worker;

-- Carry over what the transaction rows still hold. Attempts already overwritten are gone; the
-- ledger is complete from here on.
INSERT INTO chain.gas_spend (
  chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price, observed_at
)
SELECT chain_id, tx_hash, id, tenant_id, gas_used, effective_gas_price,
       COALESCE(submitted_at, updated_at)
FROM chain.transactions
WHERE tx_hash IS NOT NULL AND gas_used IS NOT NULL AND effective_gas_price IS NOT NULL
ON CONFLICT (chain_id, tx_hash) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Oldest open Safe proposal
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.operational_gauges()
RETURNS TABLE (metric TEXT, label TEXT, value BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT 'anchor_transactions'::TEXT, t.state::TEXT, COUNT(*)
  FROM chain.transactions t
  GROUP BY t.state

  UNION ALL

  SELECT 'outbox_pending'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.outbox
  WHERE published_at IS NULL

  UNION ALL

  SELECT 'uploads_quarantined'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.object_uploads
  WHERE state = 'quarantined'

  UNION ALL

  SELECT 'worker_seconds_since_heartbeat'::TEXT, h.worker_kind,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - h.last_seen_at)))::BIGINT)
  FROM core.worker_heartbeats h

  UNION ALL

  SELECT 'notification_deliveries'::TEXT, d.state, COUNT(*)
  FROM core.notification_deliveries d
  GROUP BY d.state

  UNION ALL

  -- No row while no proposal is open: an absent series, not a 0 that reads as "fresh".
  SELECT 'anchor_proposal_oldest_age_seconds'::TEXT, 'proposed'::TEXT,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MIN(p.created_at))))::BIGINT)
  FROM chain.anchor_proposals p
  WHERE p.state = 'proposed'
  HAVING COUNT(*) > 0
$$;

REVOKE EXECUTE ON FUNCTION core.operational_gauges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.operational_gauges() TO mpc_app;
