-- Chain submission tracking — spec 06 §6.8, 08 §8.9
--
-- `chain.transactions` held only tx_hash·block_number·state until now. That cannot
-- distinguish three things.
--
-- 1. **Reorg vs. normal finality** — block_number alone cannot detect a switch to a different
--    block at the same height. Marking confirmed and then silently vanishing is the worst case.
-- 2. **Retryable vs. permanent failure** — without the last error, the operator keeps retrying
--    without knowing why it stopped.
-- 3. **Submission time vs. confirmation time** — if they are the same, latency is unobservable.
--
-- State only moves forward: created → submitted → included → confirmed. `included` is
-- not success. Only `confirmed`, which has reached the confirmation depth, is success; until
-- then the `included` field of the public proof is false.

ALTER TABLE chain.transactions
  -- Basis for reorg detection. A different hash at the same height means the block we saw is gone.
  ADD COLUMN block_hash TEXT CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN submitted_at TIMESTAMPTZ,
  ADD COLUMN confirmed_at TIMESTAMPTZ,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  -- Last failure reason. Needed to decide the next action.
  ADD COLUMN last_error TEXT,
  ADD COLUMN gas_used BIGINT,
  ADD COLUMN effective_gas_price NUMERIC(78, 0);

-- A confirmed transaction always carries block info. The DB rejects any path that marks
-- confirmed without evidence — so an application bug does not become a silent false confirmation.
ALTER TABLE chain.transactions
  ADD CONSTRAINT transactions_confirmed_requires_block CHECK (
    state <> 'confirmed'
    OR (tx_hash IS NOT NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL)
  );

-- A submitted transaction carries a hash. A submitted row without a hash has unknown
-- submission status, and must stay `created`.
ALTER TABLE chain.transactions
  ADD CONSTRAINT transactions_submitted_requires_hash CHECK (
    state NOT IN ('submitted', 'included', 'confirmed') OR tx_hash IS NOT NULL
  );

CREATE INDEX transactions_pending_idx
  ON chain.transactions (state, created_at)
  WHERE state IN ('created', 'submitted', 'included');

/**
 * Reorg record.
 *
 * An event where a block seen as confirmed disappeared is kept, not deleted. Even if resubmission
 * yields the same result, the fact that "it was reversed once" is evidence for judging the public history's reliability.
 */
CREATE TABLE chain.reorg_events (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  transaction_id    UUID NOT NULL REFERENCES chain.transactions(id),
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_block_number BIGINT NOT NULL,
  previous_block_hash   TEXT NOT NULL CHECK (previous_block_hash ~ '^0x[0-9a-f]{64}$'),
  detected_state    TEXT NOT NULL
);

ALTER TABLE chain.reorg_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.reorg_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chain.reorg_events
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON chain.reorg_events TO mpc_app;

-- Reorg observations cannot be deleted afterward. Withholding UPDATE·DELETE is the control.

-- ---------------------------------------------------------------------------
-- Background worker role
--
-- Anchor submission and outbox publishing are system processes that work **across rows
-- of multiple tenants**. This differs from the API, where one request belongs to one tenant.
--
-- Until now the worker ran on a superuser connection. It bypasses RLS either way, but
-- a superuser can also do everything else — schema changes, role creation, access to other DBs.
-- A dedicated role narrows the bypass to what is needed.
DO $$
BEGIN
  CREATE ROLE mpc_worker NOLOGIN BYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA core, chain, audit TO mpc_worker;
-- Outbox publishing: read and stamp published_at.
GRANT SELECT, UPDATE ON core.outbox TO mpc_worker;
-- Anchor submission: advance transaction state and record reorgs.
GRANT SELECT, UPDATE ON chain.transactions TO mpc_worker;
GRANT SELECT ON chain.anchor_batches, chain.anchor_batch_leaves TO mpc_worker;
GRANT INSERT ON chain.reorg_events TO mpc_worker;
-- No write access to domain data. The worker handles chain state only.
