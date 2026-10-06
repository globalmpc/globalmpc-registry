-- Worker liveness signal — spec 06 §6.9.
--
-- **The problem:** there was no way to know whether the three workers (outbox·anchor·scan) were
-- alive. `scan` in particular can be disabled via a compose profile, and when it is off uploads
-- stall in `quarantined` — `promote` transitions only from `scanned_clean`. Yet
-- that stall **looks like waiting, not an error.** Neither the UI nor the API could tell "waiting
-- for a scan" from "nobody is there to scan".
--
-- **Counting rows is not enough.** The `0029` gauges count queued uploads, but
-- in a deployment with no uploads yet they read 0, and that 0 is indistinguishable from "healthy".
-- What lives here is a **signal the worker emits itself**, so it appears even when the queue is empty.
--
-- **No tenant.** Workers run across tenants, so a tenant column here would have nothing
-- meaningful to hold. Hence no RLS; instead the content is kept
-- minimal — only which kind was alive and when.

CREATE TABLE core.worker_heartbeats (
  worker_kind  TEXT PRIMARY KEY CHECK (worker_kind IN ('outbox', 'anchor', 'scan')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  /** What the last cycle did. Diagnostic only; never used for decisions. */
  detail       JSONB
);

-- Workers write, the API reads. Both are needed.
GRANT SELECT, INSERT, UPDATE ON core.worker_heartbeats TO mpc_worker;
GRANT SELECT ON core.worker_heartbeats TO mpc_app;

/**
 * Adds worker liveness to the gauges.
 *
 * Replaces the `0029` function. **Why elapsed seconds:** an absolute timestamp would force
 * the collector to subtract it again, and that calculation would repeat in every alert rule.
 *
 * A worker that has never emitted a signal **has no row.** Emitting 0 would mean "just seen",
 * so nothing is emitted — alert rules handle missing and stale separately.
 */
CREATE OR REPLACE FUNCTION core.operational_gauges()
RETURNS TABLE (metric TEXT, label TEXT, value BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT 'anchor_transactions'::TEXT, t.state::TEXT, COUNT(*)
  FROM chain.transactions t
  GROUP BY t.state

  UNION ALL

  SELECT 'outbox_pending'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.outbox
  WHERE published_at IS NULL

  UNION ALL

  SELECT 'uploads_quarantined'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.object_uploads
  WHERE state = 'quarantined'

  UNION ALL

  SELECT 'worker_seconds_since_heartbeat'::TEXT, h.worker_kind,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - h.last_seen_at)))::BIGINT)
  FROM core.worker_heartbeats h
$$;

REVOKE EXECUTE ON FUNCTION core.operational_gauges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.operational_gauges() TO mpc_app;

/**
 * Is the scan service alive — a session-authenticated lookup, not an unauthenticated one.
 *
 * The upload UI needs this value to distinguish "waiting for scan" from "no scanner
 * available". It is a tenant-independent fact, so it is read via SECURITY DEFINER —
 * `worker_heartbeats` has no tenant column, so RLS cannot be satisfied.
 *
 * Returns a single number of seconds. Who did what and when is not exposed.
 */
CREATE FUNCTION core.seconds_since_worker_heartbeat(p_worker_kind TEXT)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - h.last_seen_at)))::BIGINT)
  FROM core.worker_heartbeats h
  WHERE h.worker_kind = p_worker_kind
$$;

REVOKE EXECUTE ON FUNCTION core.seconds_since_worker_heartbeat(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.seconds_since_worker_heartbeat(TEXT) TO mpc_app;
