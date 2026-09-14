-- 운영 지표 — spec 06 §6.9.
--
-- **왜 SECURITY DEFINER인가:** `/metrics`는 세션이 없다. 수집기는 로그인하지
-- 않으므로 `core.current_tenant()`가 NULL이고, RLS가 걸린 테이블은 0행을
-- 돌려준다. 그 상태에서 나가는 "anchor 실패 0건"은 사실이 아니라 **보지 못한
-- 것**이며, 둘을 구분하지 못하면 알림 규칙이 조용히 무의미해진다.
--
-- **집계만 반환한다.** 행도, tenant_id도, 식별자도 나가지 않는다. 나가는 것은
-- 상태별 개수뿐이므로 tenant 목록이 메트릭으로 새지 않는다(`metrics.ts`가 tenant를
-- 레이블로 쓰지 않는 것과 같은 이유).
--
-- **worker에 HTTP 표면을 만들지 않는 이유도 여기 있다.** anchor·outbox·scan
-- worker가 각자 `/metrics`를 열면 세 개의 새 표면이 생기고, 더 나쁘게는 **죽은
-- worker가 아무것도 보고하지 않는다.** DB에서 세면 worker가 멈춰 있어도 쌓인
-- 행이 그대로 보인다 — 알림이 잡아야 하는 것이 바로 그 상태다.

CREATE FUNCTION core.operational_gauges()
RETURNS TABLE (metric TEXT, label TEXT, value BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  -- anchor 제출 상태. `failed`·`reverted`·`reconciliation_required`가 알림 대상이다.
  SELECT 'anchor_transactions'::TEXT, t.state::TEXT, COUNT(*)
  FROM chain.transactions t
  GROUP BY t.state

  UNION ALL

  -- 발행되지 않은 outbox. 사라진 것이 아니라 늦어진 것을 구분하는 값이다.
  SELECT 'outbox_pending'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.outbox
  WHERE published_at IS NULL

  UNION ALL

  -- quarantine에 머무는 업로드. `scan` 프로파일이 꺼진 배포에서는 여기가 쌓이고
  -- 증빙 골든 경로가 끝까지 돌지 않는다.
  SELECT 'uploads_quarantined'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.object_uploads
  WHERE state = 'quarantined'
$$;

REVOKE EXECUTE ON FUNCTION core.operational_gauges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.operational_gauges() TO mpc_app;
