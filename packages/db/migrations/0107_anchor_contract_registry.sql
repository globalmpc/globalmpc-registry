-- Every anchor contract this deployment ever used on a chain, kept apart from the rows that move.
--
-- Before moving a batch to another chain, the old chain's worker asks every contract the batch
-- could have been stored in on that chain, and refuses the move if one holds it (a second anchor
-- on the new chain would otherwise contradict the first). It found earlier contracts only through
-- rows still on that chain: `chain.transactions.contract_address` and `chain.anchor_proposals`. A
-- resubmission or a move clears a row's contract, and a move takes the row to another chain, so
-- once the last row naming contract A left, a later move asked only the configured contract B and
-- could anchor a batch a second time while A still held it.
--
-- `chain.anchor_contracts` keeps (chain, contract) for good:
--
-- - backfilled here from every contract either table names, with its chain;
-- - written by a trigger whenever a transaction row or proposal names a contract (on insert, or
--   when an update changes the chain or contract), in the writer's own transaction — so a contract is known
--   from the moment any row records it, whoever wrote the row (worker, API, or an operator). An
--   update that changes only the chain retains the old pair but registers no new pair: the row was never
--   sent to that contract on the new chain, and a pair never used is not history;
-- - and by the worker at startup for its configured contract (`INSERT … ON CONFLICT DO NOTHING`),
--   so a contract is known before anything is sent to it.
--
-- Append-only: an entry is history, not configuration. UPDATE, DELETE and TRUNCATE are rejected
-- with the shared guards (`core.reject_history_mutation`, `core.reject_truncate`).
--
-- Not tenant-scoped, and without RLS: a contract belongs to the deployment and its chain, not to a
-- tenant — every tenant's batches are sent to the same one. The address is public (it is the
-- anchor contract, already returned by the public proof functions since 0101), and no tenant data
-- is derived from it. The RLS rule (`schema.test.ts`) covers every table with `tenant_id`; this one
-- has none. Only the worker reads it: `mpc_worker` gets SELECT and INSERT, nothing else; the API
-- role gets nothing (the trigger function is SECURITY DEFINER, so the API's writes to
-- `chain.transactions` still register their contract).
--
-- Trigger installation and backfill are one transaction under bounded write-conflicting locks
-- on the durable batch history and both source tables. No writer can erase the last old contract
-- between those steps. Reads
-- continue for a superuser/BYPASSRLS migration role; a non-bypassing owner additionally takes
-- ACCESS EXCLUSIVE while temporarily lifting FORCE RLS for the backfill, then restores it.
-- A partial old no-transaction installation is safe to retry: every DDL statement is idempotent.
-- Already-applied older revisions are repaired by 0134; checksum compatibility never reruns an
-- applied migration. Contracts erased before this fix cannot be inferred from current rows.

SET LOCAL lock_timeout = '5s';
LOCK TABLE chain.anchor_batches, chain.transactions, chain.anchor_proposals IN SHARE ROW EXCLUSIVE MODE;

SELECT set_config('mpc.anchor_registry_fresh', (to_regclass('chain.anchor_contracts') IS NULL)::text, true);

CREATE TABLE IF NOT EXISTS chain.anchor_contracts (
  chain_id         INTEGER NOT NULL,
  contract_address TEXT NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  -- When it was registered. For contracts backfilled below, when this migration ran.
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address)
);

CREATE OR REPLACE TRIGGER anchor_contracts_no_update
  BEFORE UPDATE ON chain.anchor_contracts
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE OR REPLACE TRIGGER anchor_contracts_no_delete
  BEFORE DELETE ON chain.anchor_contracts
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();

CREATE OR REPLACE TRIGGER anchor_contracts_no_truncate
  BEFORE TRUNCATE ON chain.anchor_contracts
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

REVOKE ALL ON chain.anchor_contracts FROM PUBLIC;
GRANT SELECT, INSERT ON chain.anchor_contracts TO mpc_worker;

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

-- The backfill and empty-history proof read every tenant's rows. All three tables force row-level
-- security on their owner (0002, 0014). A migration role that is neither superuser nor BYPASSRLS — a managed service's
-- admin, such as Aurora's `rds_superuser` member — would read no row and record an empty registry
-- without an error. So:
--
-- - `row_security = off` turns any read that a policy would still filter into an error instead
--   of fewer rows: an incomplete backfill fails the migration, it is never recorded;
-- - a role that does not bypass RLS lifts FORCE on all three tables for the read and puts it back.
--   That needs ownership (a role that does not own them fails here, loudly), and it is one
--   statement, so it is one transaction: no other session ever sees FORCE lifted, and a failure
--   rolls the lift back with the rest. It takes ACCESS EXCLUSIVE on all three tables until the read
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
    ALTER TABLE chain.anchor_batches NO FORCE ROW LEVEL SECURITY;
  END IF;

  -- Absence of the registry alone does not prove a fresh deployment: an old batch may have
  -- cleared its last contract before 0107 existed. Only an entirely empty anchor history can
  -- establish automatic readiness. The locks also prevent a writer racing this empty proof.
  IF current_setting('mpc.anchor_registry_fresh') = 'true' THEN
    PERFORM set_config('mpc.anchor_registry_fresh', (
      NOT EXISTS (SELECT 1 FROM chain.anchor_batches)
      AND NOT EXISTS (SELECT 1 FROM chain.transactions)
      AND NOT EXISTS (SELECT 1 FROM chain.anchor_proposals)
    )::text, true);
  END IF;

  INSERT INTO chain.anchor_contracts (chain_id, contract_address)
  SELECT DISTINCT chain_id, contract_address FROM chain.transactions WHERE contract_address IS NOT NULL
  UNION
  SELECT DISTINCT chain_id, contract_address FROM chain.anchor_proposals
  ON CONFLICT DO NOTHING;

  IF lift THEN
    ALTER TABLE chain.transactions FORCE ROW LEVEL SECURITY;
    ALTER TABLE chain.anchor_proposals FORCE ROW LEVEL SECURITY;
    ALTER TABLE chain.anchor_batches FORCE ROW LEVEL SECURITY;
  END IF;
END
$$;

INSERT INTO chain.anchor_contract_registry_verification (id, basis, evidence_note)
SELECT true, 'atomic_initialization', 'Empty anchor history and new contract registry verified atomically before writers resumed'
WHERE current_setting('mpc.anchor_registry_fresh') = 'true'
ON CONFLICT DO NOTHING;
