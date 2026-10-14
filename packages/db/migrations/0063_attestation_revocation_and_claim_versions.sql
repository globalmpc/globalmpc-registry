-- Attestation revocation record and claim versions — spec 04 §4.2·§4.6, 05 §5.3,
-- 07 §7.2, REQ-DAPP-004·006.
--
-- Corrections are new versions. Nothing here deletes or overwrites a signed attestation or a
-- claim's content.

/**
 * Who revoked an attestation, when and why.
 *
 * `state = 'revoked'` alone does not say whether the signer withdrew it or something else
 * happened. The signed body stays as it was (0003 trigger); only these columns are added.
 */
ALTER TABLE core.verification_attestations
  ADD COLUMN revoked_at        TIMESTAMPTZ,
  ADD COLUMN revoked_by        UUID,
  ADD COLUMN revocation_reason TEXT,
  ADD CONSTRAINT attestations_revoked_by_same_tenant
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES core.subjects (tenant_id, id),
  ADD CONSTRAINT attestation_revocation_needs_reason CHECK (
    revoked_at IS NULL OR (revocation_reason IS NOT NULL AND length(btrim(revocation_reason)) > 0)
  );

/**
 * An attestation is superseded by at most one signed successor.
 *
 * Drafts are excluded — two reviewers may prepare corrections, but only one can take effect.
 * Without this, two successors would both claim to be "the" current judgment.
 */
CREATE UNIQUE INDEX attestations_one_signed_successor
  ON core.verification_attestations (supersedes_id)
  WHERE supersedes_id IS NOT NULL AND state <> 'draft';

/**
 * Claim versions.
 *
 * `submitted_by` records who put the claim in — 02 §2.4 rule 1 needs it to tell whether an
 * assigned reviewer is judging their own evidence. Nullable: claims created before this
 * migration have no recorded submitter, and independence review treats that as not evaluable.
 *
 * A correction is a new claim row that `supersedes_claim_id` the old one (REQ-DAPP-006). The old
 * row keeps its value and gets `superseded_by_claim_id` — the chain can be walked both ways.
 */
ALTER TABLE core.claims
  ADD COLUMN submitted_by           UUID,
  ADD COLUMN supersedes_claim_id    UUID,
  ADD COLUMN superseded_by_claim_id UUID,
  ADD COLUMN superseded_at          TIMESTAMPTZ,
  ADD COLUMN correction_reason      TEXT,
  ADD CONSTRAINT claims_submitted_by_same_tenant
    FOREIGN KEY (tenant_id, submitted_by) REFERENCES core.subjects (tenant_id, id),
  ADD CONSTRAINT claims_supersedes_same_tenant
    FOREIGN KEY (tenant_id, supersedes_claim_id) REFERENCES core.claims (tenant_id, id),
  ADD CONSTRAINT claims_superseded_by_same_tenant
    FOREIGN KEY (tenant_id, superseded_by_claim_id) REFERENCES core.claims (tenant_id, id),
  ADD CONSTRAINT claim_correction_needs_reason CHECK (
    supersedes_claim_id IS NULL
    OR (correction_reason IS NOT NULL AND length(btrim(correction_reason)) > 0)
  ),
  ADD CONSTRAINT claim_superseded_fields_together CHECK (
    (superseded_by_claim_id IS NULL) = (superseded_at IS NULL)
  );

-- A claim has at most one successor. Two corrections of the same value fork its history.
CREATE UNIQUE INDEX claims_one_successor ON core.claims (supersedes_claim_id)
  WHERE supersedes_claim_id IS NOT NULL;

/**
 * A claim's content is immutable — invariant 4, REQ-DAPP-006.
 *
 * What changes over a claim's life is its assessment (grade, verification state, staleness) and
 * the link to its successor. The value, its unit, as-of date, source and submitter do not: a
 * changed value is a new claim that supersedes this one. Without this guard an UPDATE would
 * rewrite what reviewers already signed over, and the attestation's snapshot hash could not be
 * reproduced.
 */
CREATE OR REPLACE FUNCTION core.protect_claim_content() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id            IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id        IS DISTINCT FROM OLD.project_id
     OR NEW.claim_type        IS DISTINCT FROM OLD.claim_type
     OR NEW.value_text        IS DISTINCT FROM OLD.value_text
     OR NEW.unit              IS DISTINCT FROM OLD.unit
     OR NEW.as_of             IS DISTINCT FROM OLD.as_of
     OR NEW.source_coordinate IS DISTINCT FROM OLD.source_coordinate
     OR NEW.source_receipt_id IS DISTINCT FROM OLD.source_receipt_id
     OR NEW.submitted_by      IS DISTINCT FROM OLD.submitted_by
     OR NEW.supersedes_claim_id IS DISTINCT FROM OLD.supersedes_claim_id
     OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'A claim''s content cannot be modified. Correct it with a new claim version that supersedes it'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The successor link is written once. Re-pointing it would rewrite which version replaced this one.
  IF OLD.superseded_by_claim_id IS NOT NULL
     AND NEW.superseded_by_claim_id IS DISTINCT FROM OLD.superseded_by_claim_id
  THEN
    RAISE EXCEPTION 'A claim''s successor cannot be changed once recorded'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER claim_content_immutable
  BEFORE UPDATE ON core.claims
  FOR EACH ROW EXECUTE FUNCTION core.protect_claim_content();

CREATE TRIGGER claim_no_delete
  BEFORE DELETE ON core.claims
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();
