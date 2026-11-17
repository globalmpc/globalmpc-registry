-- Freeze contributor identity separately from evaluation/signature formats.
-- NULL identifies historical assessments with no captured provenance; do not backfill guesses.
ALTER TABLE core.compliance_assessments ADD COLUMN evidence_actor_ids UUID[]
  CHECK (evidence_actor_ids IS NULL OR array_position(evidence_actor_ids,NULL) IS NULL);
CREATE FUNCTION core.guard_gate_decision_independence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actors UUID[];
BEGIN
  SELECT a.evidence_actor_ids INTO actors FROM core.compliance_assessments a
  WHERE a.id=NEW.input_assessment_id AND a.tenant_id=NEW.tenant_id AND a.project_id=NEW.project_id;
  IF actors IS NULL THEN RAISE EXCEPTION 'Gate assessment requires contributor provenance; reassess'; END IF;
  IF NEW.decision_maker_subject_id=ANY(actors) THEN
    RAISE EXCEPTION 'Gate decider must be independent of assessment evidence contributors';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gate_decision_independence BEFORE INSERT ON core.gate_decisions
FOR EACH ROW EXECUTE FUNCTION core.guard_gate_decision_independence();
