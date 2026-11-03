-- A Safe payload identifier is not its outer chain execution hash. Keep every observed outer
-- hash with the original proposal/tenant/chain, even after resubmission replaces transactions.
-- Legacy executed proposals deliberately remain unmapped: only verified Safe-service evidence
-- may populate their history, never a guess from the latest transaction row or gas ledger.
-- The worker is the trusted recorder of that external evidence; migration operators may also
-- reconcile verified historical executions. Application accounts cannot read or write this ledger.
SET LOCAL lock_timeout = '5s';

ALTER TABLE chain.transactions
  ADD CONSTRAINT transactions_safe_execution_identity UNIQUE (id, tenant_id);
ALTER TABLE chain.anchor_proposals
  ADD CONSTRAINT anchor_proposals_execution_identity UNIQUE (id, transaction_id, tenant_id, chain_id);

CREATE TABLE chain.safe_execution_history (
  proposal_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES core.tenants(id),
  chain_id INTEGER NOT NULL,
  execution_tx_hash TEXT NOT NULL CHECK (execution_tx_hash ~ '^0x[0-9a-f]{64}$'),
  evidence_kind TEXT NOT NULL DEFAULT 'proposal_execution'
    CHECK (evidence_kind IN ('proposal_execution', 'nonce_replacement')),
  evidence_note TEXT,
  CHECK (evidence_kind <> 'nonce_replacement' OR length(btrim(evidence_note)) > 0 AND evidence_note IS NOT NULL),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, execution_tx_hash),
  FOREIGN KEY (transaction_id, tenant_id) REFERENCES chain.transactions (id, tenant_id),
  FOREIGN KEY (proposal_id, transaction_id, tenant_id, chain_id)
    REFERENCES chain.anchor_proposals (id, transaction_id, tenant_id, chain_id)
);
CREATE INDEX safe_execution_history_transaction_idx
  ON chain.safe_execution_history (transaction_id, chain_id);
ALTER TABLE chain.safe_execution_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain.safe_execution_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chain.safe_execution_history
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());
REVOKE ALL ON chain.safe_execution_history FROM PUBLIC, mpc_app, mpc_worker;
GRANT SELECT, INSERT ON chain.safe_execution_history TO mpc_worker;

CREATE TRIGGER safe_execution_history_no_update BEFORE UPDATE ON chain.safe_execution_history
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();
CREATE TRIGGER safe_execution_history_no_delete BEFORE DELETE ON chain.safe_execution_history
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();
CREATE TRIGGER safe_execution_history_no_truncate BEFORE TRUNCATE ON chain.safe_execution_history
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

-- Freeze even legacy executed proposals without a mapping: changing their state or identity
-- would hide the unresolved execution from the move guard. checked_at may still advance.
CREATE FUNCTION chain.freeze_executed_proposal_identity() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = chain, pg_temp AS $$
BEGIN
  IF OLD.state IN ('executed', 'rejected') AND ROW(
    NEW.id, NEW.transaction_id, NEW.tenant_id, NEW.chain_id, NEW.safe_address,
    NEW.contract_address, NEW.calldata, NEW.calldata_hash, NEW.safe_tx_hash, NEW.state, NEW.resolved_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.transaction_id, OLD.tenant_id, OLD.chain_id, OLD.safe_address,
    OLD.contract_address, OLD.calldata, OLD.calldata_hash, OLD.safe_tx_hash, OLD.state, OLD.resolved_at
  ) THEN
    RAISE EXCEPTION 'Executed Safe proposal identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER anchor_proposals_executed_identity_frozen BEFORE UPDATE ON chain.anchor_proposals
  FOR EACH ROW EXECUTE FUNCTION chain.freeze_executed_proposal_identity();

-- The effective invoker must see the matching executed proposal in its own scope; the FK pins
-- the immutable identities. No SECURITY DEFINER privilege lets an application session add rows.
CREATE FUNCTION chain.check_safe_execution_history() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = chain, pg_temp AS $$
BEGIN
  PERFORM 1 FROM chain.anchor_proposals p
  WHERE p.id = NEW.proposal_id AND p.transaction_id = NEW.transaction_id
    AND p.tenant_id = NEW.tenant_id AND p.chain_id = NEW.chain_id
    AND ((p.state = 'executed' AND NEW.evidence_kind = 'proposal_execution')
      OR (p.state = 'rejected' AND NEW.evidence_kind = 'nonce_replacement'))
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Safe execution history requires matching proposal state and evidence kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER safe_execution_history_scope BEFORE INSERT ON chain.safe_execution_history
  FOR EACH ROW EXECUTE FUNCTION chain.check_safe_execution_history();
REVOKE EXECUTE ON FUNCTION chain.freeze_executed_proposal_identity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION chain.check_safe_execution_history() FROM PUBLIC;
