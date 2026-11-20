CREATE OR REPLACE FUNCTION core.apply_invited_workspace_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core, pg_temp AS $$
BEGIN
  UPDATE core.subjects SET assurance_level = CASE WHEN NEW.invited_role='project_member'
    THEN 'identity_bound'::core.assurance_level ELSE 'high_assurance'::core.assurance_level END,
    version=version+1
  WHERE tenant_id=NEW.tenant_id AND id=NEW.accepted_subject_id AND email=NEW.email AND organization_id=NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation recipient mismatch'; END IF;
  INSERT INTO core.role_bindings(id, tenant_id, subject_id, role, organization_id, project_id, scope_kind, governance_scope)
  VALUES (gen_random_uuid(), NEW.tenant_id, NEW.accepted_subject_id, NEW.invited_role,
    CASE WHEN NEW.invited_role <> 'administrator' THEN NEW.organization_id END,
    NEW.invited_project_id, CASE WHEN NEW.invited_role='administrator' THEN 'tenant' ELSE 'organization' END, 'none');
  RETURN NEW;
END $$;

-- Acceptance and the generated grant use the same transaction timestamp.
ALTER TABLE core.role_bindings DISABLE TRIGGER role_bindings_guard;
UPDATE core.role_bindings b
SET organization_id = i.organization_id, version = b.version + 1
FROM core.invitations i
WHERE i.state = 'accepted' AND i.invited_role IN ('project_member', 'reviewer')
  AND b.tenant_id = i.tenant_id AND b.subject_id = i.accepted_subject_id
  AND b.role = i.invited_role AND b.project_id = i.invited_project_id
  AND b.granted_at = i.accepted_at AND b.organization_id IS NULL AND b.revoked_at IS NULL;
ALTER TABLE core.role_bindings ENABLE TRIGGER role_bindings_guard;
