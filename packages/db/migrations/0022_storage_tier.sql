-- 저장 등급 게이트 — OD-17·OD-18 (2026-08-14 초안 결정).
--
-- 초안 단계의 저장 경로는 하나다. provider 관리 키(SSE-S3)로 암호화된 단일
-- 버킷이며 tenant별 키 분리도 rotation·crypto-shredding 절차도 없다.
--
-- 그 경로가 받아도 되는 등급만 받는다. 실제 계약서·개인정보는 **별도의
-- secured route**가 열린 뒤에 올린다(OD-18 재판정과 함께).
--
-- 애플리케이션도 같은 것을 검사한다. 여기 두는 이유는 **라우트를 우회하는
-- 경로가 생겨도 남기 위해서다** — 마이그레이션 스크립트, 관리자 SQL,
-- 나중에 추가될 다른 업로드 route가 전부 이 제약을 지난다.

ALTER TABLE core.object_uploads
  ADD CONSTRAINT object_uploads_draft_tier_only
  CHECK (sensitivity IN ('public', 'restricted'));

COMMENT ON CONSTRAINT object_uploads_draft_tier_only ON core.object_uploads IS
  'OD-18 초안 결정: secured route가 생기기 전까지 민감 등급을 받지 않는다. '
  'secured route를 만들 때 이 제약을 등급별 저장 경로 판정으로 바꾼다.';
