-- Attestation 서명 요청 — spec 07 §7.2.
--
-- "Signature request는 한 번만 사용하며 nonce·expiry·domain separation·expected
-- version으로 replay와 snapshot substitution을 차단한다."
--
-- 서버는 사용자 private key를 보관하지 않는다. 이 테이블은 "무엇에 대한 서명을
-- 요청했는가"만 기록하며, 서명 결과는 attestation 행에 들어간다.

CREATE TABLE core.attestation_signature_requests (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  attestation_id         UUID NOT NULL,
  nonce                  TEXT NOT NULL UNIQUE CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  -- 요청 시점의 근거. 제출 시점에 이 값이 달라졌으면 근거가 바뀐 것이므로
  -- 서명을 받아들이지 않는다(snapshot substitution 방어).
  evidence_snapshot_hash TEXT NOT NULL CHECK (evidence_snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  payload_hash           TEXT NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
  issued_at              TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  consumed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signature_request_tenant_scope_key UNIQUE (tenant_id, id),
  CONSTRAINT signature_request_expiry CHECK (expires_at > issued_at)
);

ALTER TABLE core.attestation_signature_requests
  ADD CONSTRAINT signature_request_attestation_same_tenant
    FOREIGN KEY (tenant_id, attestation_id)
    REFERENCES core.verification_attestations (tenant_id, id);

ALTER TABLE core.attestation_signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.attestation_signature_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.attestation_signature_requests
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.attestation_signature_requests TO mpc_app;

CREATE INDEX signature_requests_pending_idx
  ON core.attestation_signature_requests (attestation_id)
  WHERE consumed_at IS NULL;

-- 요청 기록은 지우지 않는다. 누가 무엇에 서명을 요청했는지가 감사 대상이다.
CREATE TRIGGER signature_request_no_delete
  BEFORE DELETE ON core.attestation_signature_requests
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- 서명 전 attestation은 본문을 고칠 수 있어야 하므로(draft) 0003의 트리거가
-- draft를 예외로 둔다. 다만 signature가 비어 있는 draft 상태에서도
-- signer_wallet_address는 배정된 검토자의 주소여야 한다 — 서명 후 다른 사람의
-- 주소로 바꿔치기하는 경로를 막는다.
ALTER TABLE core.verification_attestations
  ALTER COLUMN signature DROP NOT NULL;
