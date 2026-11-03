-- A stuck anchor transaction can be asked to move to another chain; its old chain's worker decides.
--
-- A resubmit from a deployment whose `CHAIN_ID` differs from the row's chain cannot reset the row
-- itself. Once moved, only the new chain's worker looks at it, so the root must provably not be on
-- the old chain — and the database cannot prove that: any holder of the contract's submitter role
-- (the Safe, another signer) could have stored the batch there without a trace here. Only the old
-- contract can answer (`getBatch`), and only a worker on that chain can ask it.
--
-- So the API records a request and the old chain's worker carries it out:
--   `move_to_chain_id`  the chain the row should move to; never its current chain;
--   `move_requested_at` when it was (last) asked for.
-- Both are set together or not at all. The worker on `chain_id` picks requested rows, waits until
-- nothing of the row is still in flight there, asks the old contract, and either resets the row
-- onto `move_to_chain_id` (batch absent) or clears the request and reconciles the batch it found.
-- The row's `chain_id` changes only in that reset; until then every chain-keyed reader (claims,
-- backlog, other-chain warnings, public proofs) sees the row where it is.
--
-- No grant changes: mpc_app (the API) and mpc_worker hold table-level UPDATE on
-- chain.transactions (0012), which covers the new columns. The existing triggers on the table
-- (state outbox, contract freeze, reorg-watch reset) read none of them.
--
-- Nothing here scans or rewrites `chain.transactions`, so its brief ACCESS EXCLUSIVE lock does not
-- hold up the API or the worker: the columns are nullable with no default (catalog only), and the
-- checks are added NOT VALID — enforced on every write from now on, existing rows not yet read.
-- 0106 validates them and builds the index without blocking writers.
--
-- While a request is pending, the worker records what it last saw, so it does not read as
-- ignored:
--   `move_checked_at`   when the old chain's worker last looked at the request (null: not yet);
--   `move_wait_reason`  why it is still waiting (e.g. `open_send`, `signer_pending`).
-- Both exist only while a request is pending; whoever sets, replaces, carries out or drops a
-- request clears them with it.

ALTER TABLE chain.transactions
  ADD COLUMN move_to_chain_id INTEGER,
  ADD COLUMN move_requested_at TIMESTAMPTZ,
  ADD COLUMN move_checked_at TIMESTAMPTZ,
  ADD COLUMN move_wait_reason TEXT,
  ADD CONSTRAINT transactions_move_to_other_chain
    CHECK (move_to_chain_id IS NULL OR move_to_chain_id <> chain_id) NOT VALID,
  ADD CONSTRAINT transactions_move_requested_together
    CHECK ((move_to_chain_id IS NULL) = (move_requested_at IS NULL)) NOT VALID,
  ADD CONSTRAINT transactions_move_checked_only_while_requested
    CHECK (move_to_chain_id IS NOT NULL OR (move_checked_at IS NULL AND move_wait_reason IS NULL))
    NOT VALID;
