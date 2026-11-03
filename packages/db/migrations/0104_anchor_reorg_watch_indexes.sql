-- migrate:no-transaction
-- Index the anchor worker's watch-set lookups so they read only rows still being watched.
--
-- Confirmed rows are kept forever, and almost all of them are past their reorg watch. The worker's
-- claim (every pass) and its other-chain report (once a minute) both select confirmed rows still
-- rechecked: before their stored deadline (`reorg_watch_until`, 0103), or — rows without one —
-- confirmed within a window, or with a chain search still to retry (0102). The report also counts
-- `proposed` rows, which `transactions_pending_idx` (0012) leaves out. None of these had an index,
-- so both queries scanned every confirmed row ever kept.
--
-- The deadline compares with `now()`, which no partial-index predicate may hold, so the deadline
-- and confirmation time are the keys; the predicate keeps out every row that is not confirmed.
-- Each arm of the queries' OR matches one of these indexes, so the planner combines them
-- (BitmapOr) with `transactions_pending_idx` instead of scanning the table.
--
-- - `transactions_reorg_watch_idx` — `reorg_watch_until > now()` ranges over the first column;
--   the report's fallback for rows confirmed before 0103, `reorg_watch_until IS NULL AND
--   confirmed_at > …`, over both.
-- - `transactions_confirmed_at_idx` — confirmed within a window, whatever the deadline: the
--   claim's own-watch floor and the watch extension (`confirmed_at > now() - watch`).
-- - `transactions_confirmed_search_idx` — confirmed rows with a chain search to retry: few, and
--   they leave the index once the search resolves.
-- - `transactions_proposed_idx` — rows waiting for Safe execution.
--
-- Built concurrently, outside a transaction (`-- migrate:no-transaction`, see the runner):
-- `chain.transactions` only grows, and a plain build holds a SHARE lock for its whole run,
-- blocking the API's inserts and the worker's updates. A concurrent build fails rather than block
-- them and can leave an INVALID index behind; the file is then unrecorded and runs again from the
-- top, so each index is dropped first — concurrently too — whatever state it was left in, and
-- built again. The file is recorded only once all four are built.
--
-- Indexes only: no row, column, grant or behaviour changes, so the previous release runs
-- unchanged on this schema.

DROP INDEX CONCURRENTLY IF EXISTS chain.transactions_reorg_watch_idx;
CREATE INDEX CONCURRENTLY transactions_reorg_watch_idx
  ON chain.transactions (reorg_watch_until, confirmed_at)
  WHERE state = 'confirmed';

DROP INDEX CONCURRENTLY IF EXISTS chain.transactions_confirmed_at_idx;
CREATE INDEX CONCURRENTLY transactions_confirmed_at_idx
  ON chain.transactions (confirmed_at)
  WHERE state = 'confirmed';

DROP INDEX CONCURRENTLY IF EXISTS chain.transactions_confirmed_search_idx;
CREATE INDEX CONCURRENTLY transactions_confirmed_search_idx
  ON chain.transactions (chain_id)
  WHERE state = 'confirmed' AND (chain_search_failed_since IS NOT NULL OR retry_after IS NOT NULL);

DROP INDEX CONCURRENTLY IF EXISTS chain.transactions_proposed_idx;
CREATE INDEX CONCURRENTLY transactions_proposed_idx
  ON chain.transactions (chain_id)
  WHERE state = 'proposed';
