-- Operational gauges — spec 06 §6.9.
--
-- **Why SECURITY DEFINER:** `/metrics` has no session. The collector does not log in,
-- so `core.current_tenant()` is NULL and RLS-protected tables return 0 rows.
-- An "anchor failures: 0" reported in that state is not a fact but **something not
-- seen**, and failing to tell them apart silently makes alert rules meaningless.
--
-- **Returns aggregates only.** No rows, no tenant_id, no identifiers. Only counts
-- per state leave, so the tenant list does not leak through metrics (same reason `metrics.ts`
-- does not use tenant as a label).
--
-- **This is also why workers get no HTTP surface.** If the anchor·outbox·scan
-- workers each opened `/metrics`, that would add three new surfaces, and worse, **a dead
-- worker reports nothing.** Counting in the DB shows accumulated rows even while a worker
-- is stopped — exactly the state alerts must catch.

CREATE FUNCTION core.operational_gauges()
RETURNS TABLE (metric TEXT, label TEXT, value BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  -- Anchor submission states. `failed`·`reverted`·`reconciliation_required` are alert targets.
  SELECT 'anchor_transactions'::TEXT, t.state::TEXT, COUNT(*)
  FROM chain.transactions t
  GROUP BY t.state

  UNION ALL

  -- Unpublished outbox. Distinguishes delayed from lost.
  SELECT 'outbox_pending'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.outbox
  WHERE published_at IS NULL

  UNION ALL

  -- Uploads sitting in quarantine. In deployments with the `scan` profile off, these pile up
  -- and the evidence golden path never completes.
  SELECT 'uploads_quarantined'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.object_uploads
  WHERE state = 'quarantined'
$$;

REVOKE EXECUTE ON FUNCTION core.operational_gauges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.operational_gauges() TO mpc_app;
