-- migrate:no-transaction
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
--   when an update changes the contract), in the writer's own transaction — so a contract is known
--   from the moment any row records it, whoever wrote the row (worker, API, or an operator). An
--   update that changes only the chain and keeps the contract registers nothing: the row was never
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
-- Outside a transaction (`-- migrate:no-transaction`, see the runner) so that no lock is held
-- across statements. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `chain.transactions` and on
-- `chain.anchor_proposals`. Once granted it is held only for the catalog change, but it must
-- first wait for every transaction holding a write lock on the table — and while it waits, every
-- later writer (the API's inserts, the worker's updates) queues behind it. A long-running or
-- idle-in-transaction session that has written to either table therefore stalls all writes until
-- it ends. Before running this, check `pg_stat_activity` for such sessions, as the deployment
-- runbook describes (long `xact_start`, `state = 'idle in transaction'`), and end or wait them out.
-- The backfill runs after both triggers exist and reads the two tables (for a superuser or
-- BYPASSRLS role an ordinary snapshot, no lock that blocks writers; see the backfill for any other
-- owner): a write committed before a trigger existed
-- had to finish before that CREATE TRIGGER could take its lock, so the backfill sees it; any later
-- write fires the trigger. Rerunnable from any point after a partial failure (the file is then
-- unrecorded and runs again from the top): each statement is idempotent.
--
-- The previous release runs unchanged on this schema: its writes fire the trigger, which needs no
-- privilege of theirs, and nothing it reads changes.

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

CREATE OR REPLACE FUNCTION chain.register_anchor_contract() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = chain, pg_temp
AS $$
BEGIN
  INSERT INTO chain.anchor_contracts (chain_id, contract_address)
  VALUES (NEW.chain_id, NEW.contract_address)
  ON CONFLICT DO NOTHING;
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
  AFTER UPDATE OF contract_address ON chain.transactions
  FOR EACH ROW
  WHEN (NEW.contract_address IS NOT NULL AND NEW.contract_address IS DISTINCT FROM OLD.contract_address)
  EXECUTE FUNCTION chain.register_anchor_contract();

CREATE OR REPLACE TRIGGER anchor_proposals_register_contract_on_insert
  AFTER INSERT ON chain.anchor_proposals
  FOR EACH ROW
  EXECUTE FUNCTION chain.register_anchor_contract();

CREATE OR REPLACE TRIGGER anchor_proposals_register_contract_on_update
  AFTER UPDATE OF contract_address ON chain.anchor_proposals
  FOR EACH ROW
  WHEN (NEW.contract_address IS DISTINCT FROM OLD.contract_address)
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
