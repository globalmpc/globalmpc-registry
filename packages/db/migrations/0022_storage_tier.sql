-- Storage tier gate — OD-17·OD-18 (draft decision, 2026-08-14).
--
-- The draft stage has a single storage path: one bucket encrypted with provider-managed keys
-- (SSE-S3), with no per-tenant key separation and no rotation or crypto-shredding procedure.
--
-- Accept only the tiers that path may hold. Real contracts and personal data go up only
-- after a **separate secured route** opens (together with the OD-18 re-decision).
--
-- The application checks the same thing. It lives here too **so it survives any path that
-- bypasses the route** — migration scripts, admin SQL, and any upload route added
-- later all pass through this constraint.

ALTER TABLE core.object_uploads
  ADD CONSTRAINT object_uploads_draft_tier_only
  CHECK (sensitivity IN ('public', 'restricted'));

COMMENT ON CONSTRAINT object_uploads_draft_tier_only ON core.object_uploads IS
  'OD-18 초안 결정: secured route가 생기기 전까지 민감 등급을 받지 않는다. '
  'secured route를 만들 때 이 제약을 등급별 저장 경로 판정으로 바꾼다.';
