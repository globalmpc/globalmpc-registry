-- 출처 변경 전파 — spec 05, AC-04 · AC-21.
--
-- 지금까지 전파는 authority → source connection 한 구간뿐이었다(0020). 그 아래가
-- 없었던 이유는 트리거를 안 만들어서가 아니라 **claim이 receipt를 가리키지
-- 않았기 때문이다.**
--
-- `claims.source_coordinate`는 `{"page":"1","document":"extract"}` 형태로 **문서
-- 안의 위치**만 담는다. 어느 receipt에서 나온 값인지는 어디에도 없었다. 즉:
--
--   1. 출처가 취소돼도 그 출처에서 나온 claim을 찾을 수 없다.
--   2. claim이 근거 없이 존재할 수 있고, 그것을 검출할 방법이 없다.
--
-- 두 번째가 더 크다. 이 제품의 전제가 "claim은 검증 가능한 receipt에 근거한다"인데
-- 그 연결이 자유 텍스트였다.

ALTER TABLE core.claims
  /**
   * 이 claim이 나온 receipt.
   *
   * nullable이다 — 이 컬럼이 없던 동안 만들어진 claim이 있고, receipt 없이
   * 사람이 직접 입력하는 경로도 남아 있다. **없는 것을 있다고 채우지 않는다.**
   * 대신 아래 `evidence_backed` 뷰가 근거 있는 claim과 없는 claim을 나눈다.
   */
  ADD COLUMN source_receipt_id UUID,
  /**
   * 이 claim의 근거가 흔들린 시점 — AC-21.
   *
   * `verification_state`를 건드리지 않는다. 그 값은 "누가 어느 수준으로
   * 검토했나"이고 그 사실은 출처가 취소돼도 바뀌지 않는다. **검토는 실제로
   * 있었다.** 달라진 것은 그 검토가 딛고 있던 근거다.
   */
  ADD COLUMN stale_since  TIMESTAMPTZ,
  ADD COLUMN stale_reason TEXT,
  ADD CONSTRAINT claims_stale_needs_reason
    CHECK (stale_since IS NULL OR (stale_reason IS NOT NULL AND length(btrim(stale_reason)) > 0)),
  -- tenant 경계를 넘는 참조를 FK 검사가 통과시킨다(RLS는 FK를 우회한다).
  ADD CONSTRAINT claims_source_receipt_fk
    FOREIGN KEY (tenant_id, source_receipt_id)
    REFERENCES core.source_receipts (tenant_id, id);

CREATE INDEX claims_source_receipt_idx ON core.claims (source_receipt_id)
  WHERE source_receipt_id IS NOT NULL;
CREATE INDEX claims_stale_idx ON core.claims (project_id) WHERE stale_since IS NOT NULL;

ALTER TABLE core.verification_attestations
  -- attestation은 이미 `stale_candidate` 상태를 갖는다(0001 CHECK). 없는 것은
  -- 왜 그렇게 됐는지다. 이유 없이 상태만 바뀌면 다음 사람이 판단할 수 없다.
  ADD COLUMN stale_reason TEXT;

/**
 * receipt → claim 전파.
 *
 * receipt는 append-only라 UPDATE되지 않는다. 대신 **연동이 내려갈 때** 그
 * 연동에서 나온 receipt에 딸린 claim을 표시한다.
 *
 * `degraded`·`disabled`만 본다. `access_confirmed`(수동 전환)는 접근이 사라진
 * 것이 아니라 자동 호출 경로가 없어진 것이므로 근거가 흔들린 것이 아니다.
 */
CREATE OR REPLACE FUNCTION core.propagate_connection_to_claims() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  marked INTEGER;
BEGIN
  IF NEW.state NOT IN ('degraded', 'disabled') OR OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  WITH affected AS (
    UPDATE core.claims c
    SET stale_since = now(),
        stale_reason = format('출처 연동이 %s 상태가 됐다 (connection %s)',
                              NEW.state, NEW.connection_key)
    FROM core.source_receipts r
    WHERE c.source_receipt_id = r.id
      AND r.connection_id = NEW.id
      -- 이미 표시된 것은 그대로 둔다. 처음 흔들린 시점이 기록이다.
      AND c.stale_since IS NULL
    RETURNING c.id
  )
  SELECT count(*) INTO marked FROM affected;

  RETURN NEW;
END
$$;

CREATE TRIGGER source_connections_propagate_to_claims
  AFTER UPDATE ON core.source_connections
  FOR EACH ROW EXECUTE FUNCTION core.propagate_connection_to_claims();

/**
 * claim → attestation 전파 — AC-21.
 *
 * attestation의 `claim_scope`가 이 claim을 담고 있으면 재검토 대상이다.
 *
 * **`active`만 옮긴다.** `signed`는 아직 활성이 아니고, `revoked`·`superseded`는
 * 이미 끝난 것이며, `disputed`는 이미 사람이 보고 있다. 끝난 기록을 다시
 * 건드리면 "언제 무엇이 유효했나"가 흐려진다.
 *
 * 서명 사실은 지우지 않는다. 상태만 재검토 대기로 옮긴다.
 */
CREATE OR REPLACE FUNCTION core.propagate_claim_to_attestations() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stale_since IS NULL OR OLD.stale_since IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE core.verification_attestations a
  SET state = 'stale_candidate',
      stale_reason = format('근거 claim이 흔들렸다: %s', NEW.stale_reason)
  WHERE a.tenant_id = NEW.tenant_id
    AND a.state = 'active'
    AND NEW.id = ANY (a.claim_scope);

  RETURN NEW;
END
$$;

CREATE TRIGGER claims_propagate_to_attestations
  AFTER UPDATE ON core.claims
  FOR EACH ROW EXECUTE FUNCTION core.propagate_claim_to_attestations();

/**
 * 근거 없는 claim을 드러내는 뷰.
 *
 * **자동으로 고치지 않는다.** 근거 없는 claim이 존재한다는 사실 자체가 정보이고,
 * 그것을 조용히 지우거나 등급을 낮추면 왜 그랬는지가 사라진다. 운영이 보고
 * 판단한다.
 */
CREATE OR REPLACE VIEW core.claims_without_evidence AS
SELECT c.id, c.tenant_id, c.project_id, c.claim_type, c.evidence_tier,
       c.verification_state, c.grade, c.created_at
FROM core.claims c
WHERE c.source_receipt_id IS NULL;

GRANT SELECT ON core.claims_without_evidence TO mpc_app;
