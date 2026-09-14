-- worker 생존 신호 — spec 06 §6.9.
--
-- **무엇이 문제였나:** worker 세 종(outbox·anchor·scan)이 살아 있는지 알 방법이
-- 없었다. 특히 `scan`은 compose 프로파일로 꺼 둘 수 있고, 꺼져 있으면 업로드가
-- `quarantined`에서 멈춘다 — `promote`는 `scanned_clean`에서만 전이한다. 그런데
-- 그 정지는 **오류가 아니라 대기처럼 보인다.** 화면도 API도 "검사를 기다리는
-- 중"과 "검사할 사람이 아예 없음"을 구분하지 못했다.
--
-- **행을 세는 것으로는 부족하다.** `0029`의 게이지는 쌓인 업로드를 세지만,
-- 업로드가 아직 없는 배포에서는 0이고 그 0은 "정상"과 구분되지 않는다. 반대로
-- 여기 있는 것은 **worker가 스스로 남기는 신호**라 큐가 비어 있어도 나온다.
--
-- **tenant가 없다.** worker는 여러 tenant를 가로질러 돌므로 이 표에 tenant를 두면
-- 무엇을 넣어야 할지가 없다. 그래서 RLS를 걸지 않고, 대신 담는 것을 최소로
-- 유지한다 — 어느 종류가 언제 살아 있었나뿐이다.

CREATE TABLE core.worker_heartbeats (
  worker_kind  TEXT PRIMARY KEY CHECK (worker_kind IN ('outbox', 'anchor', 'scan')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  /** 마지막 주기에 무엇을 했는지. 진단용이며 판정에 쓰지 않는다. */
  detail       JSONB
);

-- worker가 쓰고 API가 읽는다. 둘 다 필요하다.
GRANT SELECT, INSERT, UPDATE ON core.worker_heartbeats TO mpc_worker;
GRANT SELECT ON core.worker_heartbeats TO mpc_app;

/**
 * 게이지에 worker 생존을 더한다.
 *
 * `0029`의 함수를 갈아끼운다. **초 단위 경과**로 내는 이유: 절대 시각을 내면
 * 수집기가 그것을 다시 빼야 하고, 그 계산이 알림 규칙마다 반복된다.
 *
 * 한 번도 신호를 남기지 않은 worker는 **행이 없다.** 0으로 내면 "방금 봤다"가
 * 되므로 내지 않는다 — 없는 것과 오래된 것을 알림 규칙이 각각 다루게 한다.
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
 * 검사 서비스가 살아 있는가 — 무인증이 아니라 세션 있는 조회용.
 *
 * 업로드 화면이 "검사 대기"와 "검사할 사람이 없음"을 구분해 말하려면 이 값이
 * 필요하다. tenant와 무관한 사실이므로 SECURITY DEFINER로 읽는다 —
 * `worker_heartbeats`에는 tenant 컬럼이 없어 RLS를 만족시킬 방법이 없다.
 *
 * 반환은 초 하나뿐이다. 누가 언제 무엇을 했는지는 나가지 않는다.
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
