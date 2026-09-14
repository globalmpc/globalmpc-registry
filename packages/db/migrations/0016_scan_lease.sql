-- Scan lease — spec 05 §5.2
--
-- The scan worker reports results through the API (so as not to bypass state machine checks,
-- audit, or If-Match). But calling the API while holding a `FOR UPDATE` row lock **deadlocks** —
-- the API tries to lock the same row, and that lock is released only when the worker's transaction ends.
--
-- So the transaction is split.
--
--   1. Short transaction: take the lease and increment the attempt count. Commit.
--   2. Outside the transaction: read the object, scan it, report through the API.
--
-- This creates a window without a lock, and the lease stands in for it. An expired
-- lease can be taken by another worker — so a dead worker does not leave the file
-- unscanned forever.

ALTER TABLE core.object_uploads
  ADD COLUMN scan_leased_until TIMESTAMPTZ;

-- Pending lookup also checks lease expiry. Partial index, so promoted rows are excluded.
DROP INDEX IF EXISTS core.object_uploads_pending_scan_idx;
CREATE INDEX object_uploads_pending_scan_idx
  ON core.object_uploads (scan_leased_until NULLS FIRST, uploaded_at)
  WHERE state = 'quarantined';
