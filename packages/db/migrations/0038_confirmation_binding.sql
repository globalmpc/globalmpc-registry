-- 확정은 서버가 만든 근거에만 결속된다 — 2026-09-10 실사 A1.
--
-- 0021이 "서명 증거가 있어야 확정된다"를 넣었지만, 그 증거는 **요청 본문이
-- 보내는 boolean**이었다. `source.upload` 권한자가 `signatureValid: true`를
-- 보내면 그대로 `confirmed_from_source`가 됐다. bulk export의
-- `observedFields`도 요청자가 적어 보냈다.
--
-- 즉 제약은 있었지만 그것이 요구한 것은 **주장의 존재**였지 검증의 존재가
-- 아니었다. 아래 세 제약은 **누가 만든 근거인가**를 요구한다.
--
-- 라우트가 같은 것을 먼저 막는다(422 + nextAction). 여기 있는 이유는 라우트가
-- 하나가 아니고 앞으로 더 생기기 때문이다 — 한 곳만 막으면 그곳을 지나지 않는
-- 경로가 생기는 순간 조용히 열린다.
--
-- 전부 `NOT VALID`다. `source_receipts`는 append-only이고 트리거가 UPDATE를
-- 거절한다 — 과거 receipt를 새 규칙에 맞게 고칠 방법이 설계상 없다. 규칙이
-- 없던 시절의 receipt가 남는다는 뜻이며, 그것을 감추지 않는다.

/**
 * 서명 문서 — 무엇을 무슨 규칙으로 확인했는지가 함께 남는다.
 *
 * `documentHash`가 없으면 "이 해시의 원문을 다시 받아 대조한다"가 성립하지
 * 않고, `verifierVersion`이 없으면 검증 규칙이 바뀐 뒤에 과거 확정을 재현할
 * 수 없다. `verifiedBy = 'server'`가 그 둘을 만든 주체를 고정한다.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT signed_document_confirmation_is_server_bound
  CHECK (
    collection_method <> 'verifiable_signed_document'
    OR result <> 'confirmed_from_source'
    OR (
      channel_evidence ->> 'verifiedBy' = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'verifierVersion'
      AND (channel_evidence ->> 'signerRecognized') = 'true'
    )
  ) NOT VALID;

/**
 * bulk export — 관측된 필드가 **파일에서 나왔다는 사실**까지 요구한다.
 *
 * 0021은 `observedFields` 키의 존재만 봤다. 그 키는 요청자가 채울 수 있었다.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT bulk_export_confirmation_is_server_bound
  CHECK (
    collection_method <> 'official_bulk_export'
    OR result <> 'confirmed_from_source'
    OR (
      channel_evidence ->> 'verifiedBy' = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'extractorVersion'
      AND channel_evidence ? 'observedFields'
    )
  ) NOT VALID;

/**
 * API 수집 — 서버가 실제로 출처를 부른 경로에서만 확정된다.
 *
 * 사람이 결과를 적어 넣는 입구에서 이 채널을 확정할 수 있으면, **호출하지
 * 않고 "호출해서 확인했다"를 기록**할 수 있다. 그 기록은 `/collect`가 만든
 * 것과 구분되지 않는다.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT api_confirmation_requires_server_collection
  CHECK (
    collection_method <> 'authenticated_api'
    OR result <> 'confirmed_from_source'
    OR channel_evidence ->> 'collector' = 'server_adapter'
  ) NOT VALID;
