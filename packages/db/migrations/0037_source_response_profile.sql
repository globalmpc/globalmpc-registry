-- 출처 응답 profile — 2026-09-10 실사 A7.
--
-- 지금까지 `authenticated_api` 채널의 스키마 판정은 **JSON 파싱 성공**이었다.
-- 그래서 HTTP 200에 `{"error":"unavailable"}`이나 `{}`가 와도
-- `confirmed_from_source`가 됐다 — 출처가 "답할 수 없다"고 말한 것을 확인으로
-- 기록하는 경로다.
--
-- 다른 세 채널에는 이미 대조 대상이 있다: bulk export는 `schema_fingerprint`,
-- signed document는 서명, manual은 두 번째 검토. API 채널만 없었다.
--
-- **대조 대상은 연동이 갖는다.** 코드에 기관이 없다(OD-43) — 어떤 응답이
-- 정상인지는 기관마다 다르고, 그것을 코드에 적으면 기관이 늘 때마다 코드가
-- 바뀐다.

ALTER TABLE core.source_connections
  /**
   * 정상 응답이 반드시 갖는 최상위 필드.
   *
   * `schema_fingerprint`를 그대로 쓴다 — 새 컬럼을 만들면 bulk export와 API가
   * 같은 질문에 서로 다른 답을 갖게 된다. 이 주석은 그 재사용을 기록으로
   * 남기기 위한 것이며 컬럼을 더하지 않는다.
   */

  -- "그 조건의 기록이 없다"를 담는 필드와 그 값. `{"found": false}`이면
  -- ('found', 'false')다. 404가 아니라 200으로 알리는 등록부가 있다.
  ADD COLUMN response_record_absent_field TEXT,
  ADD COLUMN response_record_absent_value TEXT,
  -- 200인데 업무 오류를 담는 필드. 값이 있으면 성공이 아니다.
  ADD COLUMN response_business_error_field TEXT;

/**
 * 기록 없음 판정은 필드와 값이 **둘 다** 있어야 성립한다.
 *
 * 한쪽만 있으면 판정이 조용히 꺼진다 — 그 상태는 오류가 아니라 "그 응답은
 * 기록 없음이 아니다"로 읽히고, 결과가 확정 쪽으로 기운다.
 */
ALTER TABLE core.source_connections
  ADD CONSTRAINT source_connection_record_absent_pair
  CHECK (
    (response_record_absent_field IS NULL) = (response_record_absent_value IS NULL)
  );
