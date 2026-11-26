-- Keep independent disclosure approvals as historical decisions. The existing
-- self-publication trigger still checks the live administrator, project scope,
-- draft freshness, and the restricted project projection.
CREATE OR REPLACE FUNCTION core.guard_registry_draft_disclosure_approval() RETURNS trigger
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

CREATE OR REPLACE FUNCTION core.guard_registry_disclosure_reviewer() RETURNS trigger
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

  RETURN NEW;
END;
$$;

-- Draft identity fields are internal data. A solo publication carries only system identifiers
-- and structured fields. Check both the frozen draft and the version it actually publishes.
CREATE FUNCTION core.guard_administrator_solo_projection() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, core, pg_temp
AS $$
BEGIN
  IF NEW.state = 'published' AND NEW.decided_by_subject_id = NEW.proposed_by_subject_id
    AND NOT EXISTS (
      SELECT 1
      FROM core.projects p
      JOIN core.registry_entries e ON e.registry_type = 'project' AND e.subject_id = p.id
      JOIN core.registry_entry_versions v ON v.entry_id = e.id
      WHERE p.id = NEW.subject_id
        AND v.id = NEW.entry_version_id AND v.status = 'published'
        AND NEW.public_key = 'PRJ-' || p.id::text AND e.public_key = NEW.public_key
        AND NEW.policy_version = '1.0.0' AND v.policy_version = NEW.policy_version
        AND NEW.schema_version = '1' AND v.schema_version = NEW.schema_version
        AND NEW.projection - ARRAY['stableId','hostCountry','status','version','asOf',
          'sourceAge','staleStatus','limitations','legalEffect','disclaimerCodes'] = '{}'::jsonb
        AND NEW.projection->'stableId' = to_jsonb(p.id::text)
        AND NEW.projection->'hostCountry' = to_jsonb(p.host_country_iso3::text)
        AND p.host_country_iso3::text ~ '^[A-Z]{3}$'
        AND NEW.projection->'legalEffect' = '"none"'::jsonb
        AND v.public_projection - 'reviewCommitment'::text = NEW.projection
        AND (v.public_projection->'reviewCommitment') - 'bundleHash'::text =
          '{"version":"1","reviewCount":"0","independentlyVerifiableCount":"0"}'::jsonb
        AND v.public_projection->'reviewCommitment'->>'bundleHash' ~ '^0x[0-9a-f]{64}$'
    ) THEN
    RAISE EXCEPTION 'This draft requires independent publication'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'registry_draft_solo_projection';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER registry_draft_solo_projection
  BEFORE UPDATE ON core.registry_publication_drafts
  FOR EACH ROW EXECUTE FUNCTION core.guard_administrator_solo_projection();

ALTER TABLE core.registry_publication_drafts ENABLE ALWAYS TRIGGER registry_draft_solo_projection;
