-- Scan attempt count — spec 05 §5.2
--
-- If the scan worker keeps failing on one file, that file blocks the queue forever.
-- Count attempts; past the cap, drop it from the pending list and leave it visible to people.
--
-- **Never auto-classify as infected.** Infection is irreversible (the state machine has
-- no `scanned_infected → promoted` path), so reaching it through a scanner outage
-- would block a clean file permanently. The state stays `quarantined`; only attempts stop.

ALTER TABLE core.object_uploads
  ADD COLUMN scan_attempts INTEGER NOT NULL DEFAULT 0;

-- For pending-scan lookup. Partial index, so promoted rows are excluded.
CREATE INDEX object_uploads_pending_scan_idx
  ON core.object_uploads (uploaded_at)
  WHERE state = 'quarantined';

-- The scan worker changes only upload state. No access to domain data.
GRANT SELECT, UPDATE ON core.object_uploads TO mpc_worker;
