-- migrate:no-transaction
-- Validates 0105's chain-move checks and indexes pending move requests, without blocking writers.
--
-- 0105 added the checks NOT VALID so it would not scan `chain.transactions` under its ACCESS
-- EXCLUSIVE lock. `VALIDATE CONSTRAINT` reads the existing rows under SHARE UPDATE EXCLUSIVE,
-- which lets the API and the worker read and write meanwhile. The columns were added empty, so
-- every row passes; the checks were already enforced on every write since 0105.
--
-- The old chain's worker finds its pending requests through `transactions_move_requested_idx`
-- instead of scanning every row. It is built concurrently, outside a transaction (see the
-- runner): a plain build holds a SHARE lock for its whole run, blocking inserts and updates.
--
-- Rerunnable from any point after a partial failure (the file is then unrecorded and runs again
-- from the top): validating a valid constraint is a no-op, and the index is dropped first —
-- concurrently too, a failed concurrent build leaves an INVALID one — and built again.
--
-- No row, column, grant or behaviour changes: the previous release runs unchanged on this schema.

ALTER TABLE chain.transactions VALIDATE CONSTRAINT transactions_move_to_other_chain;
ALTER TABLE chain.transactions VALIDATE CONSTRAINT transactions_move_requested_together;
ALTER TABLE chain.transactions VALIDATE CONSTRAINT transactions_move_checked_only_while_requested;

DROP INDEX CONCURRENTLY IF EXISTS chain.transactions_move_requested_idx;
CREATE INDEX CONCURRENTLY transactions_move_requested_idx ON chain.transactions (chain_id)
  WHERE move_to_chain_id IS NOT NULL;
