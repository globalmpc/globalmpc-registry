-- 검사 lease — spec 05 §5.2
--
-- 검사 worker는 결과를 API로 보고한다(상태기계 검사·감사·If-Match를 우회하지
-- 않기 위해서다). 그런데 `FOR UPDATE`로 행을 잠근 채 API를 부르면 **교착한다** —
-- API가 같은 행을 잠그려 하고, 그 잠금은 worker의 트랜잭션이 끝나야 풀린다.
--
-- 그래서 트랜잭션을 나눈다.
--
--   1. 짧은 트랜잭션: lease를 걸고 시도 횟수를 올린다. 커밋.
--   2. 트랜잭션 밖: 객체를 읽고 검사하고 API로 보고한다.
--
-- 잠금이 없는 구간이 생기므로 lease가 그 자리를 대신한다. 만료 시각이 지난
-- lease는 다른 worker가 가져갈 수 있다 — worker가 죽어도 그 파일이 영원히
-- 검사되지 않는 상태로 남지 않는다.

ALTER TABLE core.object_uploads
  ADD COLUMN scan_leased_until TIMESTAMPTZ;

-- 대기 조회는 lease 만료를 함께 본다. 부분 인덱스라 승격된 것은 들어가지 않는다.
DROP INDEX IF EXISTS core.object_uploads_pending_scan_idx;
CREATE INDEX object_uploads_pending_scan_idx
  ON core.object_uploads (scan_leased_until NULLS FIRST, uploaded_at)
  WHERE state = 'quarantined';
