-- Source Adapter 호출 설정 — spec 05 §5.12, OD-42.
--
-- `source_connections`에는 지금까지 `secret_reference`만 있었다. 접근 권한이
-- 확보돼도 **어디로 요청을 보낼지를 저장할 자리가 없었다.**
--
-- 값이 아니라 **참조**만 둔다는 원칙은 그대로다. endpoint와 timeout은 비밀이
-- 아니므로 여기 두고, 토큰·키는 계속 `secret_reference`가 가리키는 곳에만 있다.

ALTER TABLE core.source_connections
  -- 호출 대상. https만 허용하고 URL 안에 자격증명(`user:pass@`)을 두지 못하게
  -- 막는다. 등록부로 가는 요청은 평문으로 나갈 수 없고, URL에 든 비밀은
  -- 로그·감사·에러 메시지에 그대로 남는다.
  ADD COLUMN endpoint TEXT
    CHECK (endpoint ~ '^https://[^@[:space:]]+$'),

  -- 없으면 무한정 기다린다. 출처 하나가 멈추면 수집 전체가 멈춘다.
  ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 10000
    CHECK (timeout_ms BETWEEN 1000 AND 60000),

  -- 응답에서 기준일을 꺼낼 필드명. 없으면 기준일을 모르는 것이고,
  -- 조회 시각으로 대신 채우지 않는다.
  ADD COLUMN effective_at_field TEXT,

  -- receipt에 그대로 기록된다. 나중에 "그때 무엇으로 읽었나"의 답이다.
  ADD COLUMN adapter_version TEXT NOT NULL DEFAULT 'v0',
  ADD COLUMN source_schema_version TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN authentication_method TEXT NOT NULL DEFAULT 'none',

  -- 이용 조건. 출처가 재사용을 허락했는지는 기관마다 다르고, 모르면
  -- `unconfirmed`다. 모르는 것을 허용으로 읽으면 계약 위반이 된다.
  ADD COLUMN terms_license TEXT NOT NULL DEFAULT 'unconfirmed',
  ADD COLUMN commercial_reuse TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (commercial_reuse IN ('confirmed', 'unconfirmed', 'prohibited')),
  ADD COLUMN disclosure_permission core.sensitivity NOT NULL DEFAULT 'restricted';

/**
 * 이미 있는 거짓 `active`를 내린다.
 *
 * endpoint 컬럼이 없던 동안 `authenticated_api` 연동이 호출 대상 없이 `active`로
 * 있을 수 있었다. 그것은 연동이 아니라 **연동됐다는 표시**다. 아래 제약을 걸기
 * 전에 사실에 맞는 상태로 되돌린다.
 *
 * `access_confirmed`로 내린다 — 접근 협의 자체를 부정하는 것이 아니라 자동 호출
 * 경로가 없다는 뜻이고, 그 상태의 adapter는 `manual`로 읽힌다.
 */
UPDATE core.source_connections
SET state = 'access_confirmed'
WHERE state = 'active'
  AND collection_method = 'authenticated_api'
  AND endpoint IS NULL;

/**
 * `active`인데 호출 대상이 없을 수 없다.
 *
 * 이 제약이 없으면 endpoint 없는 연동을 `active`로 올릴 수 있고, 화면은 그것을
 * "연동됨"으로 표시한다 — R5가 막으려는 미확인 통합 과장이 DB에서 시작된다.
 *
 * API가 아닌 수집 방식(수동 확인·서명 문서)은 endpoint가 없는 것이 정상이다.
 * 그쪽은 adapter를 부르지 않는다.
 */
ALTER TABLE core.source_connections
  ADD CONSTRAINT source_connections_active_needs_endpoint
  CHECK (
    state <> 'active'
    OR collection_method <> 'authenticated_api'
    OR endpoint IS NOT NULL
  );
