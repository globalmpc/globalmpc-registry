-- 검사 시도 횟수 — spec 05 §5.2
--
-- 검사 worker가 특정 파일에서 반복해 실패하면 그 파일이 큐를 영원히 막는다.
-- 시도 횟수를 세어 상한을 넘으면 대기 목록에서 빼고, 사람이 볼 수 있게 남긴다.
--
-- **자동으로 감염 판정하지 않는다.** 감염은 되돌릴 수 없으므로(상태기계에
-- `scanned_infected → promoted` 경로가 없다) 스캐너 장애로 그 상태를 만들면
-- 정상 파일이 영구히 막힌다. 상태는 `quarantined`에 남고 시도만 멈춘다.

ALTER TABLE core.object_uploads
  ADD COLUMN scan_attempts INTEGER NOT NULL DEFAULT 0;

-- 검사 대기 조회용. 부분 인덱스라 승격된 것들은 인덱스에 들어가지 않는다.
CREATE INDEX object_uploads_pending_scan_idx
  ON core.object_uploads (uploaded_at)
  WHERE state = 'quarantined';

-- 검사 worker는 업로드의 상태만 바꾼다. 도메인 데이터에 대한 권한은 주지 않는다.
GRANT SELECT, UPDATE ON core.object_uploads TO mpc_worker;
