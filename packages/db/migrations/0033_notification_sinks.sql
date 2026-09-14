-- 알림 발신 — spec 12 §12.4.
--
-- **결정: webhook이다.**
--
-- 셋 중 메일이 가장 먼저 떠오르지만 가장 무겁다. 주체의 메일 주소를 저장하는
-- 순간 이 시스템은 개인정보를 보관하게 되고, 그것은 지금 업로드에서 422로
-- 거절하고 있는 바로 그 등급이다(OD-18). **알림 하나를 위해 그 경계를 열지
-- 않는다.** webhook의 수신 URL은 tenant의 것이지 사람의 것이 아니다.
--
-- 브라우저 푸시는 구독 정보를 사람별로 저장해야 하고 데스크톱을 열어 둔
-- 사람에게만 닿는다 — 앱 안 알림이 이미 하는 일과 크게 다르지 않다.
--
-- **비밀을 값으로 담지 않는다.** `source_connections`와 같은 규칙이다(05 §5.12) —
-- `file:`·`env:` 참조만 두고 worker가 그것을 푼다.
--
-- **종류별 라우팅을 넣지 않는다.** "철회는 급하고 gap은 다음 근무일에 봐도
-- 된다"는 사실이지만 그 긴급도 분류가 정해진 바 없다. 여기서 임의로
-- 나누면 그것이 결정이 되어 버린다. 전부 보내고, 나누는 것은 받는 쪽이 한다.

CREATE TABLE core.notification_sinks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  -- https만 받는다. 알림 본문에 프로젝트 식별자가 들어가므로 평문으로 보내지 않는다.
  url              TEXT NOT NULL CHECK (url ~ '^https://[^@[:space:]]+$'),
  -- HMAC 서명 키의 **참조**. 값이 아니다. 서명이 없으면 URL을 아는 누구나
  -- 알림을 위조할 수 있고, 알림은 사람을 움직이게 하는 신호다.
  secret_reference TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  version          INTEGER NOT NULL DEFAULT 1,

  UNIQUE (tenant_id, url)
);

-- 배달 시도 — 알림 하나 × sink 하나.
--
-- **성공만 기록하면 실패가 사라진다.** 보내지 못한 알림은 앱 안에 그대로 남아
-- 있으므로 정보가 유실되지는 않지만, "보냈다고 믿는" 상태가 생긴다.
CREATE TABLE core.notification_deliveries (
  notification_id UUID NOT NULL REFERENCES core.notifications(id),
  sink_id         UUID NOT NULL REFERENCES core.notification_sinks(id),
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  attempts        INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'delivered', 'failed')),
  last_error      TEXT,
  -- 다음 시도 시각. 즉시 재시도하면 죽은 수신처에 대고 계속 두드린다.
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
-- worker는 여러 tenant를 가로지르므로 BYPASSRLS role로 붙는다(0012와 같다).
GRANT SELECT ON core.notification_sinks TO mpc_worker;
GRANT SELECT, INSERT, UPDATE ON core.notification_deliveries TO mpc_worker;
GRANT SELECT ON core.notifications TO mpc_worker;

-- 알림이 생기면 배달 행을 만든다.
--
-- 트리거인 이유는 알림 생성과 같다 — 알림을 만드는 자리가 넷이고, 배달 행을
-- route에서 만들면 새 자리가 생길 때 빠뜨린다. 빠뜨린 것은 "그 종류만 안
-- 온다"로만 드러난다.
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

-- 게이지에 배달 상태를 더한다. 보내지 못하고 있는 것을 운영자가 알아야 한다.
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
