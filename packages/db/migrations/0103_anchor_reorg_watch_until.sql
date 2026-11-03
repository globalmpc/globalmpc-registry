-- A confirmed transaction row records until when its worker watches it for reorgs.
--
-- The anchor worker rechecks a confirmed row for `ANCHOR_REORG_WATCH_MS` after confirmation, a
-- setting of that worker alone. After `CHAIN_ID` changes, the new worker reports the old chain's
-- unsettled work (`anchor.other_chain_in_flight`) so the operator keeps the old worker running
-- until it is done — but it could not know the old worker's watch, so it assumed at least 24 h
-- for every confirmed row: a 30-minute watch kept the warning up for a day.
--
-- - `reorg_watch_until` — set by the worker in the UPDATE that marks the row `confirmed`, to
--   `confirmed_at` plus its watch; a re-confirmation after a reorg recheck sets it again. Other
--   workers read it instead of guessing. NULL on rows that are not confirmed and on rows
--   confirmed by a worker from before this release; readers fall back to the 24 h floor there.
--
-- Nullable with no default: existing rows read as "deadline unknown", and the previous release,
-- which neither reads nor writes it, runs unchanged on this schema. A deadline written for one
-- confirmation must not outlive it, though: that release, or the API's resubmission, changes
-- `confirmed_at` without knowing this column, and a stale deadline would end another worker's
-- watch early in the report. So any UPDATE that changes `confirmed_at` without also changing
-- `reorg_watch_until` clears it, falling back to the conservative floor.
--
-- Grants are unchanged: the worker holds table-level SELECT and UPDATE on `chain.transactions`
-- (0012). The column describes the worker's own schedule, not the anchor; nothing public reads it.

ALTER TABLE chain.transactions
  ADD COLUMN reorg_watch_until TIMESTAMPTZ;

CREATE FUNCTION chain.clear_stale_reorg_watch() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.reorg_watch_until := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER transactions_reorg_watch_follows_confirmation
  BEFORE UPDATE ON chain.transactions
  FOR EACH ROW
  WHEN (
    NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    AND NEW.reorg_watch_until IS NOT DISTINCT FROM OLD.reorg_watch_until
    AND NEW.reorg_watch_until IS NOT NULL
  )
  EXECUTE FUNCTION chain.clear_stale_reorg_watch();
