-- A chain search the anchor worker cannot finish waits, then gives up to a person.
--
-- Before a send, and when a receipt does not store the batch, the worker asks the chain what it
-- holds for the batch (`getBatch`, then a `RootSubmitted` log search of up to ~70 ranges). A
-- failed or incomplete search is not proof of absence, so the row waits rather than going to
-- `reconciliation_required`. Waiting without a bound, though, never surfaces a provider that
-- can never answer (a smaller `eth_getLogs` range limit, pruned history, a lasting rate limit),
-- and the row — oldest first in the claim order — would be claimed again on every pass, repeat
-- the whole search, and hold back every later row on the chain.
--
-- - `chain_search_failed_since` — when the current run of failed searches began. NULL while
--   searches succeed. Past `ANCHOR_CHAIN_SEARCH_GIVE_UP_MS` from it, the worker moves the row to
--   `reconciliation_required` with `last_error = chain_search_unavailable` and clears it.
-- - `retry_after` — the row is not claimed before this time. Set with each failed search
--   (`ANCHOR_CHAIN_SEARCH_RETRY_MS` later), cleared when a search succeeds or gives up, so the
--   failing row steps aside and other rows keep moving.
--
-- Both are nullable with no default: existing rows read as "no search failing", and the previous
-- release, which neither reads nor writes them, runs unchanged on this schema. Grants are
-- unchanged: the worker holds table-level SELECT and UPDATE on `chain.transactions` (0012). The
-- columns describe the worker's own schedule, not the anchor; nothing public reads them.

ALTER TABLE chain.transactions
  ADD COLUMN chain_search_failed_since TIMESTAMPTZ,
  ADD COLUMN retry_after TIMESTAMPTZ;
