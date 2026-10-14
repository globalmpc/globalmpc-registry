-- Anchor send ledger — O1 (daily spend cap), spec 06 §6.8
--
-- The daily cap reserved gas for sends still waiting for a receipt by reading
-- `chain.transactions`. That row describes only the latest attempt, so the reservation opened
-- whenever the row's state moved on while the transaction could still be mined:
--
-- - a resubmission (`POST /anchor-batches/:id/resubmit`) clears `tx_hash`, and the earlier
--   transaction disappeared from the count;
-- - a `dropped` transaction was watched for a fixed window, after which it no longer counted;
-- - nothing recorded the gas limit or fee a transaction was sent with.
--
-- This ledger keeps one row per hash the anchor signer signed, written **before** broadcast. A
-- row counts toward the cap at its most (gas limit × max fee) until it is settled:
--
-- - `receipt` — its receipt is recorded in `chain.gas_spend`, at its actual cost;
-- - `nonce_consumed` — the signer's nonce at a block `confirmationDepth` deep is past this
--   row's nonce and this hash has no receipt: another transaction took the nonce, so this one can
--   never be mined;
-- - `operator` — settled by hand (a pre-ledger send whose nonce is unknown). Never written by the
--   worker.
--
-- Nothing settles a row by time or by the state of its `chain.transactions` row.

CREATE TABLE chain.anchor_sends (
  chain_id         INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_id   UUID NOT NULL REFERENCES chain.transactions(id),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  -- NULL only for rows carried over below: what they were signed with was never recorded.
  signer           TEXT CHECK (signer ~ '^0x[0-9a-f]{40}$'),
  nonce            BIGINT CHECK (nonce >= 0),
  -- NULL: sent without a fixed gas limit. The cap counts it at the block gas limit.
  gas_limit        NUMERIC(78, 0) CHECK (gas_limit > 0),
  max_fee_per_gas  NUMERIC(78, 0) CHECK (max_fee_per_gas >= 0),
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last time the worker asked the chain about it. Spaces the rechecks.
  checked_at       TIMESTAMPTZ,
  settled_at       TIMESTAMPTZ,
  settled_reason   TEXT CHECK (settled_reason IN ('receipt', 'nonce_consumed', 'operator')),
  CONSTRAINT anchor_sends_settled_with_reason CHECK ((settled_at IS NULL) = (settled_reason IS NULL)),
  -- A nonce is meaningful only with its signer.
  CONSTRAINT anchor_sends_nonce_with_signer CHECK (nonce IS NULL OR signer IS NOT NULL),
  PRIMARY KEY (chain_id, tx_hash)
);

CREATE INDEX anchor_sends_open_idx ON chain.anchor_sends (chain_id, checked_at)
  WHERE settled_at IS NULL;

ALTER TABLE chain.anchor_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.anchor_sends FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chain.anchor_sends
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- The worker records sends and settles them. It cannot rewrite what was sent.
GRANT SELECT, INSERT ON chain.anchor_sends TO mpc_worker;
GRANT UPDATE (checked_at, settled_at, settled_reason) ON chain.anchor_sends TO mpc_worker;

-- Carry over every hash still without a receipt in the gas ledger, whatever its row's state —
-- a dropped or reset transaction can still be mined. Signer, nonce, gas limit and fee were never
-- recorded, so these count at the block gas limit until a receipt or an operator settles them.
-- Hashes already cleared from their rows by a resubmission are gone and cannot be carried over.
INSERT INTO chain.anchor_sends (chain_id, tx_hash, transaction_id, tenant_id, sent_at)
SELECT t.chain_id, t.tx_hash, t.id, t.tenant_id, COALESCE(t.submitted_at, t.updated_at)
FROM chain.transactions t
WHERE t.tx_hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM chain.gas_spend g WHERE g.chain_id = t.chain_id AND g.tx_hash = t.tx_hash
  )
ON CONFLICT (chain_id, tx_hash) DO NOTHING;
