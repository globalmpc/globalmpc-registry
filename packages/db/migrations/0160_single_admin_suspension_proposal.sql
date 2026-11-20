CREATE OR REPLACE FUNCTION core.subject_suspension_proposal_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_subject core.subjects;
BEGIN
  SELECT * INTO v_subject FROM core.subjects
  WHERE id = NEW.subject_id AND tenant_id = NEW.tenant_id
  FOR UPDATE;
  IF NOT FOUND OR v_subject.kind <> 'person' THEN
    RAISE EXCEPTION 'SUSPENSION_NOT_A_PERSON: only a person is suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'suspend' AND v_subject.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person is already suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'reinstate' AND v_subject.suspended_at IS NULL THEN
    RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person is not suspended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
