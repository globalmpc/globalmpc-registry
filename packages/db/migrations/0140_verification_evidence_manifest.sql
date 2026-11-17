-- Capture the actual source scope for new reviews without reinterpreting historical hashes.
-- NULL remains the legacy v1/v2 broad receipt scope. Never backfill it from live evidence.
ALTER TABLE core.verification_cases ADD COLUMN evidence_snapshot JSONB
  CHECK (evidence_snapshot IS NULL OR COALESCE(
    jsonb_typeof(evidence_snapshot)='object'
    AND evidence_snapshot->>'snapshotVersion'='3'
    AND jsonb_typeof(evidence_snapshot->'claimIds')='array'
    AND jsonb_typeof(evidence_snapshot->'artifactIds')='array'
    AND jsonb_typeof(evidence_snapshot->'receiptIds')='array'
    AND jsonb_typeof(evidence_snapshot->'claims')='array',false));

CREATE FUNCTION core.guard_verification_evidence_manifest() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.evidence_snapshot IS DISTINCT FROM OLD.evidence_snapshot
    OR (OLD.evidence_snapshot IS NOT NULL AND
      (NEW.evidence_snapshot_hash IS DISTINCT FROM OLD.evidence_snapshot_hash
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.schema_id IS DISTINCT FROM OLD.schema_id)) THEN
    RAISE EXCEPTION 'Verification evidence manifest and its basis are immutable; create a new case';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_evidence_manifest_immutable BEFORE UPDATE ON core.verification_cases
FOR EACH ROW EXECUTE FUNCTION core.guard_verification_evidence_manifest();
