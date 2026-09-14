-- 불변조건을 DB 레벨에서 강제한다.
--
-- 애플리케이션 코드만으로 막으면 마이그레이션 스크립트, 운영 콘솔, 잘못된 배포가
-- 우회할 수 있다. 여기 있는 것들은 "실수로도 뚫리면 안 되는" 항목이다.

-- ---------------------------------------------------------------------------
-- audit는 append-only다 (02 §2.7)
--
-- 권한 회수만으로는 부족하다. 권한을 다시 부여하는 실수가 가능하기 때문에
-- 트리거로 한 번 더 막는다.
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON audit.events FROM PUBLIC;
GRANT SELECT, INSERT ON audit.events TO mpc_app;

CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.events는 append-only다: % 시도가 거절됐다', TG_OP
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

-- ---------------------------------------------------------------------------
-- 서명된 attestation은 immutable이다 (04 §4.2, 불변조건 4)
--
-- 정정은 새 attestation의 supersedes 참조로 한다. state 전이와 revoke/supersede
-- 연결만 허용한다.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.protect_signed_attestation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.evidence_snapshot_hash IS DISTINCT FROM OLD.evidence_snapshot_hash
     OR NEW.payload_hash        IS DISTINCT FROM OLD.payload_hash
     OR NEW.limitations         IS DISTINCT FROM OLD.limitations
     OR NEW.findings            IS DISTINCT FROM OLD.findings
     OR NEW.citations           IS DISTINCT FROM OLD.citations
     OR NEW.signature           IS DISTINCT FROM OLD.signature
     OR NEW.signed_at           IS DISTINCT FROM OLD.signed_at
     OR NEW.signer_wallet_address IS DISTINCT FROM OLD.signer_wallet_address
     OR NEW.claim_scope         IS DISTINCT FROM OLD.claim_scope
     OR NEW.credential_status_snapshot IS DISTINCT FROM OLD.credential_status_snapshot
  THEN
    RAISE EXCEPTION
      '서명된 attestation의 본문은 수정할 수 없다. 정정은 새 version의 supersedes로 한다'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER attestation_immutable_after_signing
  BEFORE UPDATE ON core.verification_attestations
  FOR EACH ROW EXECUTE FUNCTION core.protect_signed_attestation();

CREATE OR REPLACE FUNCTION core.reject_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 는 삭제할 수 없다. revoke 또는 supersede를 사용한다', TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER attestation_no_delete
  BEFORE DELETE ON core.verification_attestations
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- ---------------------------------------------------------------------------
-- readiness 결과는 override할 수 없다 (REQ-DAPP-017, D-30)
--
-- 07 §7.2에 PATCH endpoint가 없는 것으로 1차 차단하고, 여기서 DB로 2차 차단한다.
-- 재계산은 새 행이며 기존 행을 고치는 경로는 없다.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.reject_assessment_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'readiness assessment는 수정·삭제할 수 없다. 새 input 또는 rule version으로 재계산한다'
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER assessment_no_update
  BEFORE UPDATE ON core.compliance_assessments
  FOR EACH ROW EXECUTE FUNCTION core.reject_assessment_mutation();

CREATE TRIGGER assessment_no_delete
  BEFORE DELETE ON core.compliance_assessments
  FOR EACH ROW EXECUTE FUNCTION core.reject_assessment_mutation();

-- gate decision도 마찬가지다. 결정을 바꾸려면 새 결정을 기록한다.
CREATE TRIGGER gate_decision_no_update
  BEFORE UPDATE ON core.gate_decisions
  FOR EACH ROW EXECUTE FUNCTION core.reject_assessment_mutation();

CREATE TRIGGER gate_decision_no_delete
  BEFORE DELETE ON core.gate_decisions
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- ---------------------------------------------------------------------------
-- 공개된 Registry version은 덮어쓸 수 없다 (불변조건 4, 08 §8.11)
--
-- published 이후에는 상태 전이(revoke/supersede)와 그 연결 필드만 바꿀 수 있다.
-- projection과 hash가 바뀌면 이미 anchor된 root와 어긋난다.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.protect_published_registry_version() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.public_projection     IS DISTINCT FROM OLD.public_projection
     OR NEW.content_hash       IS DISTINCT FROM OLD.content_hash
     OR NEW.source_snapshot_hash IS DISTINCT FROM OLD.source_snapshot_hash
     OR NEW.policy_version     IS DISTINCT FROM OLD.policy_version
     OR NEW.schema_version     IS DISTINCT FROM OLD.schema_version
     OR NEW.serialization_version IS DISTINCT FROM OLD.serialization_version
     OR NEW.version            IS DISTINCT FROM OLD.version
     OR NEW.entry_id           IS DISTINCT FROM OLD.entry_id
  THEN
    RAISE EXCEPTION
      '공개된 registry version은 덮어쓸 수 없다. 새 version과 supersede로 정정한다'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER registry_version_immutable_after_publish
  BEFORE UPDATE ON core.registry_entry_versions
  FOR EACH ROW EXECUTE FUNCTION core.protect_published_registry_version();

CREATE TRIGGER registry_version_no_delete
  BEFORE DELETE ON core.registry_entry_versions
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- ---------------------------------------------------------------------------
-- anchor batch의 root는 수정·삭제할 수 없다 (08 §8.4, 13 §13.5)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.reject_anchor_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'anchor batch는 수정·삭제할 수 없다. 정정은 revoke/supersede event다'
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER anchor_batch_no_update
  BEFORE UPDATE ON chain.anchor_batches
  FOR EACH ROW EXECUTE FUNCTION core.reject_anchor_mutation();

CREATE TRIGGER anchor_batch_no_delete
  BEFORE DELETE ON chain.anchor_batches
  FOR EACH ROW EXECUTE FUNCTION core.reject_anchor_mutation();

-- ---------------------------------------------------------------------------
-- source receipt도 immutable이다 (05 §5.12)
-- ---------------------------------------------------------------------------

CREATE TRIGGER source_receipt_no_update
  BEFORE UPDATE ON core.source_receipts
  FOR EACH ROW EXECUTE FUNCTION core.reject_anchor_mutation();

CREATE TRIGGER source_receipt_no_delete
  BEFORE DELETE ON core.source_receipts
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();
