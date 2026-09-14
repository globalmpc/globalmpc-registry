-- Source change propagation — spec 05, AC-04 · AC-21.
--
-- Until now propagation covered one hop only: authority → source connection (0020). Nothing
-- went further, not for lack of a trigger but **because claims did not point to
-- receipts.**
--
-- `claims.source_coordinate` holds only a **position inside a document**, e.g.
-- `{"page":"1","document":"extract"}`. Which receipt a value came from was recorded nowhere. So:
--
--   1. When a source is revoked, the claims derived from it cannot be found.
--   2. A claim can exist without evidence, and there is no way to detect it.
--
-- The second is worse. The product's premise is "claims rest on verifiable receipts",
-- yet that link was free text.

ALTER TABLE core.claims
  /**
   * The receipt this claim came from.
   *
   * Nullable — claims were created while this column did not exist, and a path for manual
   * entry without a receipt remains. **Nothing missing is filled in as present.**
   * Instead the `evidence_backed` view below separates claims with and without evidence.
   */
  ADD COLUMN source_receipt_id UUID,
  /**
   * When this claim's evidence went stale — AC-21.
   *
   * Does not touch `verification_state`. That value records "who reviewed at what level",
   * which does not change when a source is revoked. **The review did
   * happen.** What changed is the evidence it rested on.
   */
  ADD COLUMN stale_since  TIMESTAMPTZ,
  ADD COLUMN stale_reason TEXT,
  ADD CONSTRAINT claims_stale_needs_reason
    CHECK (stale_since IS NULL OR (stale_reason IS NOT NULL AND length(btrim(stale_reason)) > 0)),
  -- FK checks let references cross tenant boundaries (RLS bypasses FKs).
  ADD CONSTRAINT claims_source_receipt_fk
    FOREIGN KEY (tenant_id, source_receipt_id)
    REFERENCES core.source_receipts (tenant_id, id);

CREATE INDEX claims_source_receipt_idx ON core.claims (source_receipt_id)
  WHERE source_receipt_id IS NOT NULL;
CREATE INDEX claims_stale_idx ON core.claims (project_id) WHERE stale_since IS NOT NULL;

ALTER TABLE core.verification_attestations
  -- Attestations already have a `stale_candidate` state (0001 CHECK). What is missing is
  -- why. A state change without a reason leaves the next person unable to judge.
  ADD COLUMN stale_reason TEXT;

/**
 * receipt → claim propagation.
 *
 * Receipts are append-only and never UPDATEd. Instead, **when a connection goes down**,
 * mark the claims attached to receipts from that connection.
 *
 * Only `degraded`·`disabled` count. `access_confirmed` (manual switch) means the automatic
 * call path is gone, not that access was lost, so the evidence is not stale.
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
        stale_reason = format('Source connection became %s (connection %s)',
                              NEW.state, NEW.connection_key)
    FROM core.source_receipts r
    WHERE c.source_receipt_id = r.id
      AND r.connection_id = NEW.id
      -- Leave already-marked rows as is. The first stale time is the record.
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
 * claim → attestation propagation — AC-21.
 *
 * An attestation whose `claim_scope` contains this claim needs re-review.
 *
 * **Only `active` moves.** `signed` is not yet active, `revoked`·`superseded` are
 * already closed, and `disputed` is already under human review. Touching closed records
 * again blurs "what was valid when".
 *
 * The signature itself is not erased. Only the state moves to awaiting re-review.
 */
CREATE OR REPLACE FUNCTION core.propagate_claim_to_attestations() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stale_since IS NULL OR OLD.stale_since IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE core.verification_attestations a
  SET state = 'stale_candidate',
      stale_reason = format('Underlying claim became stale: %s', NEW.stale_reason)
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
 * View exposing claims without evidence.
 *
 * **No automatic fix.** The existence of an unbacked claim is itself information;
 * silently deleting or downgrading it erases the reason. Operations reviews and
 * decides.
 */
CREATE OR REPLACE VIEW core.claims_without_evidence AS
SELECT c.id, c.tenant_id, c.project_id, c.claim_type, c.evidence_tier,
       c.verification_state, c.grade, c.created_at
FROM core.claims c
WHERE c.source_receipt_id IS NULL;

GRANT SELECT ON core.claims_without_evidence TO mpc_app;
