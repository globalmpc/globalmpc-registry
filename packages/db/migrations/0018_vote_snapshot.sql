-- Vote weight snapshot — spec 04 §4.5, OD-06
--
-- Until now vote weight came in the request body. The voter thus set their own
-- weight — a declaration, not a vote.
--
-- Weight comes from the **on-chain balance at voting start**. Why the point in time is fixed:
--
--   1. Buying tokens during voting cannot increase weight.
--   2. Moving the same tokens across wallets cannot cast multiple votes.
--   3. Re-tallying at any time gives the same result.
--
-- The snapshot block is set when the proposal moves to `voting` and never changes afterward.

ALTER TABLE core.governance_proposals
  -- Block at voting start. The balance at this height is the weight.
  ADD COLUMN snapshot_block BIGINT,
  -- Token contract to read weight from. If absent, falls back to manual input.
  ADD COLUMN snapshot_token_address TEXT
    CHECK (snapshot_token_address ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN snapshot_chain_id INTEGER;

/**
 * Snapshotted weight.
 *
 * Why the lookup result is stored: on-chain lookups can fail and need an archive
 * node. Re-reading at every tally would make the result depend on node state.
 *
 * **Once recorded, it never changes.** Two values for the same (proposal, wallet) would
 * require deciding which one is right.
 */
CREATE TABLE core.governance_vote_weights (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  proposal_id   UUID NOT NULL,
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  -- Handled as a decimal string. Holding 18 decimals in a number loses precision.
  weight        NUMERIC(78, 0) NOT NULL CHECK (weight >= 0),
  block_number  BIGINT NOT NULL,
  read_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, wallet_address),
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES core.governance_proposals (tenant_id, id)
);

CREATE INDEX governance_vote_weights_proposal_idx
  ON core.governance_vote_weights (proposal_id);

ALTER TABLE core.governance_vote_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_vote_weights FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.governance_vote_weights
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- Snapshots are append-only. If weight can be edited, the result can be edited.
GRANT SELECT, INSERT ON core.governance_vote_weights TO mpc_app;

CREATE TRIGGER governance_vote_weights_no_delete
  BEFORE DELETE ON core.governance_vote_weights
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();

CREATE OR REPLACE FUNCTION core.reject_weight_update() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '스냅숏된 무게는 수정할 수 없다';
END
$$;

CREATE TRIGGER governance_vote_weights_no_update
  BEFORE UPDATE ON core.governance_vote_weights
  FOR EACH ROW EXECUTE FUNCTION core.reject_weight_update();

/**
 * The snapshot block is set only once.
 *
 * Moving the block during voting removes the weight basis of votes already cast.
 */
CREATE OR REPLACE FUNCTION core.protect_snapshot_block() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.snapshot_block IS NOT NULL
     AND NEW.snapshot_block IS DISTINCT FROM OLD.snapshot_block THEN
    RAISE EXCEPTION '스냅숏 블록은 정해진 뒤 바꿀 수 없다';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_proposals_snapshot_immutable
  BEFORE UPDATE ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.protect_snapshot_block();
