-- Quorum denominator — spec 09 §9.6, 04 §4.5
--
-- Until now quorum used **the sum of votes cast** as the denominator. Then
-- `turnout × D >= turnout × N` is always true while N ≤ D, so quorum always passes.
-- `no_quorum` cannot occur structurally, and a single vote closes the proposal.
--
-- 09 §9.6 requires "no quorum is a state distinct from defeated". Low turnout and
-- majority opposition call for different next steps — the former means re-announcing, the latter
-- revising the proposal.
--
-- The denominator is **fixed when voting opens**. With a linked token it is the total supply
-- at the snapshot block; otherwise a human-entered value. Which one is never hidden.

ALTER TABLE core.governance_proposals
  -- Total weight eligible to vote. Handled as a decimal string (ADR-T07).
  --
  -- Blocks 0. `turnout × D >= 0 × N` is always true, so even with a denominator quorum
  -- would revert to always passing.
  ADD COLUMN eligible_weight NUMERIC(78, 0) CHECK (eligible_weight > 0),
  -- Where the denominator came from. NULL means not yet fixed.
  ADD COLUMN eligible_weight_source TEXT
    CHECK (eligible_weight_source IN ('onchain_total_supply', 'manual'));

-- Once the source is set, the value must be too. Only one of them leaves the basis unknown.
ALTER TABLE core.governance_proposals
  ADD CONSTRAINT eligible_weight_source_requires_value CHECK (
    eligible_weight_source IS NULL OR eligible_weight IS NOT NULL
  );

/**
 * A fixed denominator never changes.
 *
 * A changeable denominator means a changeable result. The value at proposal creation is
 * still a candidate (`eligible_weight_source IS NULL`), so it can change until voting opens.
 */
CREATE OR REPLACE FUNCTION core.protect_eligible_weight() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.eligible_weight_source IS NOT NULL
     AND (NEW.eligible_weight IS DISTINCT FROM OLD.eligible_weight
          OR NEW.eligible_weight_source IS DISTINCT FROM OLD.eligible_weight_source) THEN
    RAISE EXCEPTION 'The fixed quorum basis cannot be changed';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_proposals_eligible_weight_immutable
  BEFORE UPDATE ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.protect_eligible_weight();
