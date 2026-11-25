ALTER TABLE core.registry_publication_drafts
  ADD COLUMN disclosure_approved_by_subject_id uuid REFERENCES core.subjects(id),
  ADD COLUMN disclosure_approved_at timestamptz,
  ADD CONSTRAINT registry_draft_disclosure_approval_shape CHECK (
    (disclosure_approved_by_subject_id IS NULL AND disclosure_approved_at IS NULL)
    OR (disclosure_approved_by_subject_id IS NOT NULL AND disclosure_approved_at IS NOT NULL
      AND disclosure_approved_by_subject_id <> proposed_by_subject_id
      AND administrator_publication_prepared AND registry_type = 'project')
  );

GRANT UPDATE (disclosure_approved_by_subject_id) ON core.registry_publication_drafts TO mpc_app;

CREATE FUNCTION core.guard_registry_draft_disclosure_approval() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, core, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.disclosure_approved_by_subject_id IS NOT NULL
      OR (NEW.state = 'published' AND NEW.decided_by_subject_id = NEW.proposed_by_subject_id) THEN
      RAISE EXCEPTION 'A new draft cannot carry disclosure approval'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state = 'published' AND NEW.decided_by_subject_id = NEW.proposed_by_subject_id
    AND OLD.disclosure_approved_by_subject_id IS NULL THEN
    RAISE EXCEPTION 'Independent disclosure approval is required'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'registry_draft_two_person';
  END IF;

  IF (NEW.disclosure_approved_by_subject_id, NEW.disclosure_approved_at)
    IS NOT DISTINCT FROM (OLD.disclosure_approved_by_subject_id, OLD.disclosure_approved_at) THEN
    RETURN NEW;
  END IF;

  IF OLD.disclosure_approved_by_subject_id IS NULL
    AND OLD.state = 'pending' AND NEW.state = 'pending'
    AND OLD.administrator_publication_prepared AND OLD.registry_type = 'project'
    AND NEW.disclosure_approved_by_subject_id = core.current_actor()
    AND NEW.disclosure_approved_by_subject_id <> OLD.proposed_by_subject_id
    AND NEW.version = OLD.version + 1
    AND core.actor_live()
    AND core.registry_publication_session_live(
      NULLIF(current_setting('app.registry_publication_session_id', true), '')::uuid
    )
    AND EXISTS (
      SELECT 1
      FROM core.role_bindings AS binding
      JOIN core.projects AS project ON project.id = OLD.subject_id
      JOIN core.subjects AS subject ON subject.id = binding.subject_id
      WHERE binding.subject_id = NEW.disclosure_approved_by_subject_id
        AND subject.kind = 'person' AND subject.assurance_level = 'high_assurance'
        AND binding.role = 'reviewer' AND binding.revoked_at IS NULL
        AND (binding.jurisdiction IS NULL OR project.host_country_iso3::text = ANY(binding.jurisdiction))
        AND (
          binding.project_id = project.id
          OR (binding.project_id IS NULL AND COALESCE(binding.scope_kind, 'registry') = 'registry')
          OR (binding.project_id IS NULL AND binding.scope_kind = 'organization'
            AND binding.organization_id = project.owner_organization_id)
        )
    )
  THEN
    NEW.disclosure_approved_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only an independent scoped reviewer may approve a pending draft'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'registry_draft_disclosure_approval_authority';
END;
$$;

CREATE TRIGGER registry_draft_disclosure_approval
  BEFORE INSERT OR UPDATE ON core.registry_publication_drafts
  FOR EACH ROW EXECUTE FUNCTION core.guard_registry_draft_disclosure_approval();

ALTER TABLE core.registry_publication_drafts ENABLE ALWAYS TRIGGER registry_draft_disclosure_approval;

-- A disclosure decision is bound to the immutable fields of its draft even during replication.
ALTER TABLE core.registry_publication_drafts ENABLE ALWAYS TRIGGER registry_publication_drafts_guard;
