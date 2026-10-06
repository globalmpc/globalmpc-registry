-- Attestation signature requests — spec 07 §7.2.
--
-- "A signature request is single-use and blocks replay and snapshot substitution with nonce,
-- expiry, domain separation, and expected version."
--
-- The server never holds user private keys. This table records only "what a signature was
-- requested for"; the signature itself goes in the attestation row.

CREATE TABLE core.attestation_signature_requests (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  attestation_id         UUID NOT NULL,
  nonce                  TEXT NOT NULL UNIQUE CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  -- The evidence at request time. If this value differs at submission, the evidence changed,
  -- so the signature is rejected (snapshot substitution defense).
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

-- Request records are never deleted. Who requested a signature on what is subject to audit.
CREATE TRIGGER signature_request_no_delete
  BEFORE DELETE ON core.attestation_signature_requests
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- An unsigned attestation must remain editable (draft), so the 0003 trigger exempts
-- drafts. Even so, in the draft state with an empty signature,
-- signer_wallet_address must be the assigned reviewer's address — this blocks swapping in
-- someone else's address after signing.
ALTER TABLE core.verification_attestations
  ALTER COLUMN signature DROP NOT NULL;
