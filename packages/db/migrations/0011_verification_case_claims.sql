-- Preserve the review scope of a verification case — 04 §4.2·§4.4
--
-- Until now, the claim list at case creation went only into the evidence snapshot hash.
-- A hash only tells **whether it changed**; it cannot restore **what it was**.
--
-- That made two things impossible.
--
-- 1. The assigner and the signer are different people (02 §2.4), yet a reviewer could not
--    look up the review scope of their own case.
-- 2. A post-signature audit could not answer "what evidence did this signature cover" from
--    the DB alone. An attestation's claim_scope is re-entered by the reviewer, so nothing
--    guarantees it matches the scope the case assigned.
--
-- The scope is fixed at assignment and never changes. To change it, create a new case.

CREATE TABLE core.verification_case_claims (
  tenant_id  UUID NOT NULL REFERENCES core.tenants(id),
  case_id    UUID NOT NULL,
  claim_id   UUID NOT NULL,
  PRIMARY KEY (case_id, claim_id),
  -- tenant_id is part of the FK. FK checks bypass RLS, so without a composite (tenant_id, id)
  -- reference a row could point at another tenant's row (same reason as 0006).
  FOREIGN KEY (tenant_id, case_id) REFERENCES core.verification_cases (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES core.claims (tenant_id, id)
);

CREATE INDEX verification_case_claims_case_idx
  ON core.verification_case_claims (case_id);

ALTER TABLE core.verification_case_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.verification_case_claims FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.verification_case_claims
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.verification_case_claims TO mpc_app;

-- The assigned scope cannot be changed afterward. Withholding UPDATE·DELETE is the control.
