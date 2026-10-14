-- Signed gate decisions — spec 11 §11.3 (Gate Decision: decision snapshot/hash, assumption,
-- sign), 07 §7.2.
--
-- **Why:** `gate_decisions.signature` was NOT NULL but the route defaulted it to an empty string
-- and never checked it. A decision "signed" by nobody is indistinguishable from one the approver
-- signed, and the column promised something it did not hold.
--
-- The decision is signed the same way an attestation is (0008): the server issues a single-use
-- EIP-712 request over the decision payload, the approver signs with their own wallet, and the
-- server recovers the signer and checks it is the deciding subject's wallet. The server holds no
-- key and signs for no one.

CREATE TABLE core.gate_decision_signature_requests (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES core.tenants(id),
  project_id          UUID NOT NULL,
  -- Who may use it. A request issued to one approver cannot carry another's decision.
  subject_id          UUID NOT NULL,
  input_assessment_id UUID NOT NULL,
  gate_id             TEXT NOT NULL,
  nonce               TEXT NOT NULL UNIQUE CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  -- Commitment to decision, rationale, assumptions and conditions. The submission must carry
  -- the same content, or the signature covered something else.
  payload_hash        TEXT NOT NULL CHECK (payload_hash ~ '^0x[0-9a-f]{64}$'),
  issued_at           TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gate_signature_request_tenant_scope_key UNIQUE (tenant_id, id),
  CONSTRAINT gate_signature_request_expiry CHECK (expires_at > issued_at),
  CONSTRAINT gate_signature_request_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  CONSTRAINT gate_signature_request_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT gate_signature_request_assessment_same_tenant
    FOREIGN KEY (tenant_id, input_assessment_id) REFERENCES core.compliance_assessments (tenant_id, id)
);

ALTER TABLE core.gate_decision_signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.gate_decision_signature_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.gate_decision_signature_requests
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- UPDATE only to consume. Who asked to sign what is subject to audit, so no DELETE.
GRANT SELECT, INSERT, UPDATE ON core.gate_decision_signature_requests TO mpc_app;

CREATE TRIGGER gate_signature_request_no_delete
  BEFORE DELETE ON core.gate_decision_signature_requests
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

ALTER TABLE core.gate_decisions
  -- The recovered signer. Kept beside the signature so a reader need not re-run recovery to
  -- know whose wallet signed.
  ADD COLUMN signer_wallet_address TEXT CHECK (signer_wallet_address ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN signature_request_id  UUID,
  ADD CONSTRAINT gate_decision_signature_request_same_tenant
    FOREIGN KEY (tenant_id, signature_request_id)
    REFERENCES core.gate_decision_signature_requests (tenant_id, id),
  -- NOT VALID: rows recorded before this migration carry the empty string the old route wrote,
  -- and gate decisions are immutable. New rows cannot be unsigned.
  ADD CONSTRAINT gate_decision_signature_present CHECK (btrim(signature) <> '') NOT VALID;
