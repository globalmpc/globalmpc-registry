-- Notification delivery — spec 12 §12.4.
--
-- **Decision: webhook.**
--
-- Of the three, email comes to mind first but is the heaviest. The moment a subject's email
-- address is stored, this system holds personal data, which is exactly the class uploads
-- currently reject with 422 (OD-18). **That boundary is not opened for a single
-- notification.** A webhook receiver URL belongs to the tenant, not to a person.
--
-- Browser push must store subscription data per person and only reaches people with a desktop
-- open — not much different from what in-app notifications already do.
--
-- **Secrets are not stored as values.** Same rule as `source_connections` (05 §5.12) —
-- only `file:`·`env:` references are stored, and the worker resolves them.
--
-- **No per-kind routing.** "A revoke is urgent; a gap can wait for the next business day"
-- is true, but no urgency classification has been decided. Splitting it here arbitrarily
-- would make that a decision. Everything is sent; the receiver does the splitting.

CREATE TABLE core.notification_sinks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  -- https only. Notification bodies include project identifiers, so no plaintext delivery.
  url              TEXT NOT NULL CHECK (url ~ '^https://[^@[:space:]]+$'),
  -- **Reference** to the HMAC signing key, not the value. Without a signature anyone who knows
  -- the URL can forge notifications, and notifications are signals that make people act.
  secret_reference TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1,

  UNIQUE (tenant_id, url)
);

-- Delivery attempts — one notification × one sink.
--
-- **Recording only successes makes failures disappear.** An undelivered notification stays in
-- the app, so no information is lost, but a "believed sent" state arises.
CREATE TABLE core.notification_deliveries (
  notification_id UUID NOT NULL REFERENCES core.notifications(id),
  sink_id         UUID NOT NULL REFERENCES core.notification_sinks(id),
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  attempts        INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'delivered', 'failed')),
  last_error      TEXT,
  -- Next attempt time. Immediate retries keep hammering a dead receiver.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,

  PRIMARY KEY (notification_id, sink_id)
);

CREATE INDEX notification_deliveries_pending_idx
  ON core.notification_deliveries (next_attempt_at)
  WHERE state = 'pending';

ALTER TABLE core.notification_sinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.notification_sinks FORCE ROW LEVEL SECURITY;
ALTER TABLE core.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.notification_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_sinks_tenant ON core.notification_sinks FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY notification_deliveries_tenant ON core.notification_deliveries FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.notification_sinks TO mpc_app;
GRANT SELECT, INSERT, UPDATE ON core.notification_deliveries TO mpc_app;
-- Workers span tenants, so they connect with a BYPASSRLS role (same as 0012).
GRANT SELECT ON core.notification_sinks TO mpc_worker;
GRANT SELECT, INSERT, UPDATE ON core.notification_deliveries TO mpc_worker;
GRANT SELECT ON core.notifications TO mpc_worker;

-- Creates delivery rows when a notification is created.
--
-- A trigger for the same reason as notification creation — notifications are created in four
-- places, and creating delivery rows in routes would miss a new place when one is added. A miss
-- only surfaces as "that one kind never arrives".
CREATE FUNCTION core.enqueue_notification_delivery() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO core.notification_deliveries (notification_id, sink_id, tenant_id)
  SELECT NEW.id, s.id, NEW.tenant_id
  FROM core.notification_sinks s
  WHERE s.tenant_id = NEW.tenant_id AND s.state = 'active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_enqueue_delivery
  AFTER INSERT ON core.notifications
  FOR EACH ROW EXECUTE FUNCTION core.enqueue_notification_delivery();

-- Adds delivery status to the gauges. Operators must know what is failing to deliver.
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

  UNION ALL

  SELECT 'notification_deliveries'::TEXT, d.state, COUNT(*)
  FROM core.notification_deliveries d
  GROUP BY d.state
$$;

REVOKE EXECUTE ON FUNCTION core.operational_gauges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.operational_gauges() TO mpc_app;
