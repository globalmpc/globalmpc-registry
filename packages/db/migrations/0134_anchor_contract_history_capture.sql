-- Repair installed 0107 contract-history capture without rewriting already-applied schemas.
--
-- The reviewed 0107 revision is atomic for fresh installs. Older installations have already run
-- their recorded SQL; checksum compatibility only updates the record, so this migration installs
-- the corrected triggers and backfills current rows for them. The bounded locks span trigger
-- replacement and backfill; OLD identities are preserved on clear, replace and chain movement.
-- Neither this migration nor a checksum upgrade can reconstruct a contract erased before the
-- registry observed it. Reconcile deployment/chain history before moving affected old batches.

SET LOCAL lock_timeout = '5s';
LOCK TABLE chain.transactions, chain.anchor_proposals IN SHARE ROW EXCLUSIVE MODE;

-- Readiness is deployment-wide provenance, not an assertion that current rows contain all
-- history. Only a genuinely new atomic registry may establish it automatically. An older
-- installed/partial registry requires explicit operator reconciliation; workers cannot approve it.
CREATE TABLE IF NOT EXISTS chain.anchor_contract_registry_verification (
  id            BOOLEAN PRIMARY KEY CHECK (id),
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by   TEXT NOT NULL DEFAULT session_user CHECK (length(btrim(verified_by)) > 0),
  basis         TEXT NOT NULL CHECK (basis IN ('atomic_initialization', 'operator_reconciliation')),
  evidence_note TEXT NOT NULL CHECK (length(btrim(evidence_note)) BETWEEN 1 AND 2000)
);
CREATE OR REPLACE TRIGGER anchor_registry_verification_no_update
  BEFORE UPDATE ON chain.anchor_contract_registry_verification
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();
CREATE OR REPLACE TRIGGER anchor_registry_verification_no_delete
  BEFORE DELETE ON chain.anchor_contract_registry_verification
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();
CREATE OR REPLACE TRIGGER anchor_registry_verification_no_truncate
  BEFORE TRUNCATE ON chain.anchor_contract_registry_verification
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();
REVOKE ALL ON chain.anchor_contract_registry_verification FROM PUBLIC, mpc_app, mpc_worker;
GRANT SELECT ON chain.anchor_contract_registry_verification TO mpc_worker;

CREATE OR REPLACE FUNCTION chain.register_anchor_contract() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chain, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Keeping an old contract while changing its chain invents provenance for later updates.
    -- A real chain move clears the old contract before a new-chain target is assigned.
    IF NEW.chain_id IS DISTINCT FROM OLD.chain_id
       AND NEW.contract_address IS NOT NULL
       AND NEW.contract_address IS NOT DISTINCT FROM OLD.contract_address THEN
      RAISE EXCEPTION 'Clear the contract before changing its chain' USING ERRCODE = 'check_violation';
    END IF;
    -- A cleared/replaced row is the last surviving evidence of its old identity in a partial
    -- installation. Keep that persisted pair before considering the replacement.
    IF OLD.contract_address IS NOT NULL THEN
      INSERT INTO chain.anchor_contracts (chain_id, contract_address)
      VALUES (OLD.chain_id, OLD.contract_address)
      ON CONFLICT DO NOTHING;
    END IF;
    -- Merely moving a row's chain does not mean it was sent to the same contract there.
    IF NEW.contract_address IS NOT DISTINCT FROM OLD.contract_address THEN
      RETURN NULL;
    END IF;
  END IF;
  IF NEW.contract_address IS NOT NULL THEN
    INSERT INTO chain.anchor_contracts (chain_id, contract_address)
    VALUES (NEW.chain_id, NEW.contract_address)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION chain.register_anchor_contract() FROM PUBLIC;

CREATE OR REPLACE TRIGGER transactions_register_contract_on_insert
  AFTER INSERT ON chain.transactions
  FOR EACH ROW
  WHEN (NEW.contract_address IS NOT NULL)
  EXECUTE FUNCTION chain.register_anchor_contract();

CREATE OR REPLACE TRIGGER transactions_register_contract_on_update
  AFTER UPDATE OF chain_id, contract_address ON chain.transactions
  FOR EACH ROW
  WHEN ((NEW.chain_id, NEW.contract_address) IS DISTINCT FROM (OLD.chain_id, OLD.contract_address))
  EXECUTE FUNCTION chain.register_anchor_contract();

CREATE OR REPLACE TRIGGER anchor_proposals_register_contract_on_insert
  AFTER INSERT ON chain.anchor_proposals
  FOR EACH ROW
  EXECUTE FUNCTION chain.register_anchor_contract();

CREATE OR REPLACE TRIGGER anchor_proposals_register_contract_on_update
  AFTER UPDATE OF chain_id, contract_address ON chain.anchor_proposals
  FOR EACH ROW
  WHEN ((NEW.chain_id, NEW.contract_address) IS DISTINCT FROM (OLD.chain_id, OLD.contract_address))
  EXECUTE FUNCTION chain.register_anchor_contract();

-- The backfill reads every tenant's rows, and both tables force row-level security on their owner
-- (0002, 0014). A migration role that is neither superuser nor BYPASSRLS — a managed service's
-- admin, such as Aurora's `rds_superuser` member — would read no row and record an empty registry
-- without an error. So:
--
-- - `row_security = off` turns any read that a policy would still filter into an error instead
--   of fewer rows: an incomplete backfill fails the migration, it is never recorded;
-- - a role that does not bypass RLS lifts FORCE on the two tables for the read and puts it back.
--   That needs ownership (a role that does not own them fails here, loudly), and it is one
--   statement, so it is one transaction: no other session ever sees FORCE lifted, and a failure
--   rolls the lift back with the rest. It takes ACCESS EXCLUSIVE on both tables until the read
--   commits — readers and writers wait for the backfill, which is one pass over each table.
--   A superuser or BYPASSRLS role reads under its ordinary snapshot and takes no such lock;
-- - `lock_timeout = 5s`, for this statement only: waiting for ACCESS EXCLUSIVE behind an open
--   transaction on either table would queue every reader and writer of both behind it, for as
--   long as that transaction stays open. The wait ends after 5 seconds with an error instead, the
--   statement rolls back whole, and the file stays unrecorded; run `migrate` again once the
--   sessions the deployment runbook tells you to look for are gone.
DO $$
DECLARE
  lift BOOLEAN := NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('row_security', 'off', true);
  IF lift THEN
    ALTER TABLE chain.transactions NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE chain.anchor_proposals NO FORCE ROW LEVEL SECURITY;
  END IF;

  INSERT INTO chain.anchor_contracts (chain_id, contract_address)
  SELECT DISTINCT chain_id, contract_address FROM chain.transactions WHERE contract_address IS NOT NULL
  UNION
  SELECT DISTINCT chain_id, contract_address FROM chain.anchor_proposals
  ON CONFLICT DO NOTHING;

  IF lift THEN
    ALTER TABLE chain.transactions FORCE ROW LEVEL SECURITY;
    ALTER TABLE chain.anchor_proposals FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;
