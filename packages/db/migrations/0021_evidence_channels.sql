-- Evidence channel parity — spec 05 §5.12, AC-29, OD-42.
--
-- 네 채널이 같은 Source Receipt를 통과하지만 **각 채널이 막아야 하는 것이
-- 다르다.** AC-29가 명시한 셋:
--
--   1. signed document의 invalid signature
--   2. bulk export의 schema drift
--   3. manual confirmation의 second-review 누락
--
-- 채널마다 다른 테이블을 두지 않는다. 그러면 result enum과 한계 표기가 갈리고,
-- 읽는 쪽이 "이 사실은 어느 경로로 왔나"에 따라 다르게 해석해야 한다.

ALTER TABLE core.source_connections
  -- bulk export가 가져야 할 필드 목록. 관측된 것과 다르면 schema drift다.
  -- 비어 있으면 대조하지 않는다 — 모르는 것을 일치로 읽지 않는다.
  ADD COLUMN schema_fingerprint TEXT[],
  -- signed document 서명자의 공개키 참조. 값이 아니라 참조다.
  ADD COLUMN signing_key_reference TEXT;

ALTER TABLE core.source_receipts
  /**
   * 채널별 증거.
   *
   * signed document는 서명·서명자, bulk export는 관측된 필드 목록, manual은
   * 조회 경로가 들어간다. **한 컬럼에 모으는 이유**: 채널마다 컬럼을 나누면
   * 새 채널이 생길 때마다 스키마가 바뀌고, 과거 receipt를 읽는 코드가 채널을
   * 먼저 판정해야 한다.
   */
  ADD COLUMN channel_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 누가 처음 확인했는가. manual에서 두 번째 확인자와 대조하는 데 쓴다.
  ADD COLUMN first_confirmed_by  UUID REFERENCES core.subjects(id),
  ADD COLUMN second_confirmed_by UUID REFERENCES core.subjects(id),
  ADD COLUMN second_confirmed_at TIMESTAMPTZ,
  /**
   * 두 번째 검토가 이어받은 receipt.
   *
   * receipt는 append-only다(`source_receipt_no_update`). 두 번째 검토가 기존
   * 행을 고칠 수 없으므로 **새 receipt를 만들고 앞의 것을 가리킨다.** 그래서
   * "한 사람이 봤을 때"와 "두 사람이 봤을 때"가 둘 다 기록으로 남는다.
   */
  ADD COLUMN supersedes_receipt_id UUID REFERENCES core.source_receipts(id);


/**
 * 아래 제약은 모두 `NOT VALID`다.
 *
 * `source_receipts`는 append-only이며 트리거가 UPDATE를 거절한다. 즉 과거
 * receipt를 새 규칙에 맞게 고칠 방법이 **설계상 없다.** `NOT VALID`는 기존
 * 행을 검사하지 않고 새 행부터 적용한다 — 이력을 고쳐 쓰지 않으면서 규칙을
 * 세우는 유일한 방법이다.
 *
 * 채널 규칙이 없던 시절의 receipt가 남는다는 뜻이다. 그것을 감추지 않는다:
 * `channel_evidence`가 비어 있는 것이 곧 "그때는 대조하지 않았다"는 기록이다.
 */

/**
 * 같은 사람이 두 번 확인할 수 없다.
 *
 * second review의 목적은 다른 눈이다. 같은 사람을 넣을 수 있으면 형식만 남는다.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT source_receipt_second_reviewer_differs
  CHECK (second_confirmed_by IS NULL OR second_confirmed_by IS DISTINCT FROM first_confirmed_by) NOT VALID;

/**
 * 수동 확인은 두 번째 검토 없이 확정될 수 없다 — AC-29.
 *
 * 수동 경로에는 API 응답도 서명도 없다. 한 사람의 진술이 유일한 근거이므로
 * 그것만으로 `confirmed_from_source`가 되면 **가장 약한 채널이 가장 쉬운
 * 채널이 된다.**
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT manual_confirmation_needs_second_review
  CHECK (
    collection_method <> 'manual_official_registry_confirmation'
    OR result <> 'confirmed_from_source'
    OR second_confirmed_by IS NOT NULL
  ) NOT VALID;

/**
 * 서명 문서는 서명 증거 없이 확정될 수 없다 — AC-29.
 *
 * 서명이 붙은 채널인데 검증 결과가 없으면 서명을 확인하지 않은 것이다.
 * 확인하지 않은 서명은 없는 서명과 같다.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT signed_document_needs_signature_evidence
  CHECK (
    collection_method <> 'verifiable_signed_document'
    OR result <> 'confirmed_from_source'
    OR (channel_evidence ? 'signatureValid' AND (channel_evidence ->> 'signatureValid') = 'true')
  ) NOT VALID;

/**
 * bulk export는 관측된 스키마 없이 확정될 수 없다 — AC-29.
 *
 * drift를 판정하려면 무엇을 봤는지가 있어야 한다. 없으면 대조가 일어나지
 * 않았고, 그러면 스키마가 바뀐 파일을 그대로 읽은 것이다.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT bulk_export_needs_observed_schema
  CHECK (
    collection_method <> 'official_bulk_export'
    OR result <> 'confirmed_from_source'
    OR channel_evidence ? 'observedFields'
  ) NOT VALID;
