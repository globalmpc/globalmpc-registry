ALTER TABLE core.subjects
  ADD COLUMN disclosure_suspension_generation bigint NOT NULL DEFAULT 0;

ALTER TABLE core.registry_publication_drafts
  ADD COLUMN disclosure_approval_generation bigint;

-- Generation follows row-lock order, independent of transaction timestamps.
CREATE FUNCTION core.advance_disclosure_suspension_generation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, core, pg_temp
AS $$
BEGIN
  NEW.disclosure_suspension_generation := OLD.disclosure_suspension_generation;
  IF OLD.suspended_at IS NULL AND NEW.suspended_at IS NOT NULL THEN
    NEW.disclosure_suspension_generation := OLD.disclosure_suspension_generation + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subjects_disclosure_suspension_generation
  BEFORE UPDATE ON core.subjects
  FOR EACH ROW EXECUTE FUNCTION core.advance_disclosure_suspension_generation();

ALTER TABLE core.subjects ENABLE ALWAYS TRIGGER subjects_disclosure_suspension_generation;

-- Invoker privileges retain the application role's visibility rules.
CREATE FUNCTION core.registry_disclosure_approval_is_current(p_reviewer uuid, p_generation bigint)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, core, pg_temp
AS $$
DECLARE
  current_generation bigint;
BEGIN
  SELECT disclosure_suspension_generation INTO current_generation
    FROM core.subjects WHERE id = p_reviewer AND suspended_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_generation IS NOT NULL THEN
    RETURN p_generation = current_generation;
  END IF;

  -- Legacy approvals have no ordering token. Require a new draft if the reviewer
  -- has any suspension history rather than guessing the order from timestamps.
  RETURN current_generation = 0 AND NOT EXISTS (
    SELECT 1 FROM core.subject_suspensions
    WHERE subject_id = p_reviewer AND action = 'suspend' AND state = 'approved'
  );
END;
$$;

REVOKE ALL ON FUNCTION core.registry_disclosure_approval_is_current(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.registry_disclosure_approval_is_current(uuid, bigint) TO mpc_app;

CREATE FUNCTION core.guard_registry_disclosure_reviewer() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, core, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.disclosure_approval_generation := NULL;
    RETURN NEW;
  END IF;

  NEW.disclosure_approval_generation := OLD.disclosure_approval_generation;
  -- The existing approval trigger authorizes the decision and freezes the reviewer.
  IF OLD.disclosure_approved_by_subject_id IS NULL AND NEW.disclosure_approved_by_subject_id IS NOT NULL THEN
    SELECT disclosure_suspension_generation INTO NEW.disclosure_approval_generation
      FROM core.subjects WHERE id = NEW.disclosure_approved_by_subject_id AND suspended_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The disclosure reviewer is no longer active'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'registry_draft_disclosure_approval_authority';
    END IF;
  END IF;

  IF OLD.state = 'pending' AND NEW.state = 'published'
    AND NEW.decided_by_subject_id = NEW.proposed_by_subject_id
    AND NOT core.registry_disclosure_approval_is_current(
      OLD.disclosure_approved_by_subject_id, OLD.disclosure_approval_generation
    ) THEN
    RAISE EXCEPTION 'Disclosure approval is no longer valid'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'registry_draft_disclosure_reviewer_current';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER registry_draft_disclosure_reviewer
  BEFORE INSERT OR UPDATE ON core.registry_publication_drafts
  FOR EACH ROW EXECUTE FUNCTION core.guard_registry_disclosure_reviewer();

ALTER TABLE core.registry_publication_drafts ENABLE ALWAYS TRIGGER registry_draft_disclosure_reviewer;
