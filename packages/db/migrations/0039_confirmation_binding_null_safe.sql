-- 0038의 제약이 실제로는 막지 못했다 — 2026-09-10.
--
-- `jsonb ->> 'key'`는 키가 없을 때 **NULL**을 낸다. 그리고 `NULL = 'server_adapter'`는
-- FALSE가 아니라 NULL이다. **CHECK 제약은 NULL을 위반으로 보지 않는다** — 참이
-- 아닌 것과 거짓인 것이 SQL에서 다르다.
--
-- 그래서 `api_confirmation_requires_server_collection`은 `channel_evidence`가
-- 비어 있는 INSERT를 그대로 통과시켰다. 막으려고 만든 것이 정확히 그 경우를
-- 막지 못했다.
--
-- 나머지 둘은 `AND channel_evidence ? '...'`가 옆에 있어 **우연히** 걸렸다
-- (`NULL AND FALSE`는 FALSE다). 키가 전부 있고 `verifiedBy`만 없는 조합에서는
-- 같은 구멍이 열린다. 셋을 함께 고친다.
--
-- **라우트를 우회한 INSERT를 시도하는 시험이 이것을 잡았다.** 제약을 넣은 뒤
-- "넣었으니 막힌다"로 두었다면 드러나지 않았을 것이다 — 0038의 첫 판은 그
-- 상태로 커밋됐다.
--
-- 0038을 고치지 않고 새 파일을 두는 이유: 마이그레이션은 적용 시점의 체크섬으로
-- 고정된다(`runMigrations`). 이미 적용한 파일을 고치면 그 환경이 기동에서
-- 거절당한다. 틀린 것을 지우는 대신 **고친 기록을 남긴다.**

ALTER TABLE core.source_receipts
  DROP CONSTRAINT IF EXISTS signed_document_confirmation_is_server_bound,
  DROP CONSTRAINT IF EXISTS bulk_export_confirmation_is_server_bound,
  DROP CONSTRAINT IF EXISTS api_confirmation_requires_server_collection;

/**
 * 비교를 NULL로 새지 않게 한다.
 *
 * `coalesce(..., '')`는 "키가 없다"를 빈 문자열로 바꾸고, 빈 문자열은 어느
 * 기대값과도 같지 않다 — 그래서 FALSE가 되고 제약이 실제로 걸린다.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT signed_document_confirmation_is_server_bound
  CHECK (
    collection_method <> 'verifiable_signed_document'
    OR result <> 'confirmed_from_source'
    OR (
      coalesce(channel_evidence ->> 'verifiedBy', '') = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'verifierVersion'
      AND coalesce(channel_evidence ->> 'signerRecognized', '') = 'true'
    )
  ) NOT VALID;

ALTER TABLE core.source_receipts
  ADD CONSTRAINT bulk_export_confirmation_is_server_bound
  CHECK (
    collection_method <> 'official_bulk_export'
    OR result <> 'confirmed_from_source'
    OR (
      coalesce(channel_evidence ->> 'verifiedBy', '') = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'extractorVersion'
      AND channel_evidence ? 'observedFields'
    )
  ) NOT VALID;

ALTER TABLE core.source_receipts
  ADD CONSTRAINT api_confirmation_requires_server_collection
  CHECK (
    collection_method <> 'authenticated_api'
    OR result <> 'confirmed_from_source'
    OR coalesce(channel_evidence ->> 'collector', '') = 'server_adapter'
  ) NOT VALID;
