-- Safe multisig proposals — spec 08 §8.9, contract ANCHOR_SUBMITTER_ROLE
--
-- `ANCHOR_SUBMITTER_ROLE` of `RegistryAnchorV1` is held by a Safe multisig.
-- Having no sole EOA submitter is the basis for "not even MPC can silently replace
-- the confirmed public history on its own".
--
-- The worker, however, can submit only as an EOA. So there are two paths.
--
-- - Local·testnet: the worker submits directly as an EOA (development convenience).
-- - Otherwise: the worker **only creates the proposal and does not execute it.** Signature
--   collection and execution are done by people on the Safe side.
--
-- A created proposal does not mean a submission. Without distinguishing the two states,
-- nothing is on chain while everyone believes "it was posted".

CREATE TABLE chain.anchor_proposals (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  transaction_id  UUID NOT NULL REFERENCES chain.transactions(id),
  chain_id        INTEGER NOT NULL,
  safe_address    TEXT NOT NULL CHECK (safe_address ~ '^0x[0-9a-f]{40}$'),
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  -- Calldata to execute. It is what gets signed in Safe and must not differ from what is built here.
  calldata        TEXT NOT NULL CHECK (calldata ~ '^0x[0-9a-f]+$'),
  -- Hash of the proposal contents. Used to compare against what the Safe UI shows.
  calldata_hash   TEXT NOT NULL CHECK (calldata_hash ~ '^0x[0-9a-f]{64}$'),
  state           TEXT NOT NULL DEFAULT 'proposed'
                    CHECK (state IN ('proposed', 'executed', 'rejected', 'expired')),
  -- Identifier from the external Safe service. Nullable because we do not create it.
  safe_tx_hash    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

-- Only one **active** proposal per transaction. With two, signers do not know which
-- to execute, and if both execute the same root is posted twice.
-- Resolved (executed·rejected·expired) proposals may accumulate — they are history.
CREATE UNIQUE INDEX anchor_proposals_one_active_idx
  ON chain.anchor_proposals (transaction_id) WHERE state = 'proposed';

CREATE INDEX anchor_proposals_pending_idx
  ON chain.anchor_proposals (chain_id, state) WHERE state = 'proposed';

ALTER TABLE chain.anchor_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.anchor_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chain.anchor_proposals
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON chain.anchor_proposals TO mpc_app;
GRANT SELECT, INSERT, UPDATE ON chain.anchor_proposals TO mpc_worker;

-- Add 'proposed' to transaction_state. It sits between created (nothing done yet) and
-- submitted (sent to chain). Without it, staying in created hides "why isn't it
-- going up", and marking submitted waits for a transaction that does not exist.
ALTER TYPE chain.transaction_state ADD VALUE IF NOT EXISTS 'proposed' AFTER 'created';
