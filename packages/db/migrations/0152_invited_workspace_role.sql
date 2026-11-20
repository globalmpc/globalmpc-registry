-- Legacy invitations carry no access. Only the issuing transaction can attach an access decision.
ALTER TABLE core.invitations
  ADD COLUMN invited_role text CHECK (invited_role IN ('project_member','reviewer','administrator')),
  ADD COLUMN invited_project_id uuid,
  ADD COLUMN identity_basis text,
  ADD FOREIGN KEY (tenant_id, invited_project_id) REFERENCES core.projects(tenant_id, id),
  ADD CHECK ((invited_role IS NULL AND identity_basis IS NULL AND invited_project_id IS NULL)
    OR (invited_role IS NOT NULL AND identity_basis IS NOT NULL AND length(trim(identity_basis)) BETWEEN 1 AND 1000
      AND (invited_role <> 'administrator' OR invited_project_id IS NULL)));

CREATE FUNCTION core.create_role_invitation(p_id uuid, p_org uuid, p_email text, p_session uuid,
  p_hash text, p_link text, p_role text, p_project uuid, p_basis text)
RETURNS TABLE(status text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp AS $$
DECLARE
  actor core.sessions := core.mfa_lock_session(p_session);
  result record;
BEGIN
  IF actor.recovery_limited OR core.mfa_session_rank(actor) < 3 OR NOT EXISTS (
    SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id AND s.tenant_id=b.tenant_id
    WHERE b.tenant_id=actor.tenant_id AND b.subject_id=actor.subject_id AND b.role='administrator'
      AND b.revoked_at IS NULL AND b.project_id IS NULL AND b.scope_kind='tenant' AND b.jurisdiction IS NULL
      AND s.suspended_at IS NULL AND s.assurance_level='high_assurance'
  ) THEN
    RETURN QUERY SELECT 'not_authorized'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.projects WHERE tenant_id=actor.tenant_id AND id=p_project AND owner_organization_id=p_org
  ) THEN
    RETURN QUERY SELECT 'project_unknown'::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO result FROM core.create_invitation(p_id,p_org,p_email,actor.subject_id,p_hash,p_link);
  IF result.status='created' THEN
    UPDATE core.invitations SET invited_role=p_role, invited_project_id=p_project, identity_basis=trim(p_basis)
    WHERE id=p_id AND tenant_id=actor.tenant_id;
  END IF;
  RETURN QUERY SELECT result.status::text, result.expires_at::timestamptz;
END $$;
REVOKE ALL ON FUNCTION core.create_role_invitation(uuid,uuid,text,uuid,text,text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.create_role_invitation(uuid,uuid,text,uuid,text,text,text,uuid,text) TO mpc_app;

-- Both verified-email and OIDC acceptance create the subject and transition the locked invitation
-- in the same transaction. The role, scope and verification basis are frozen at issuance.
CREATE FUNCTION core.apply_invited_workspace_role() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core, pg_temp AS $$
BEGIN
  UPDATE core.subjects SET assurance_level = CASE WHEN NEW.invited_role='project_member'
    THEN 'identity_bound'::core.assurance_level ELSE 'high_assurance'::core.assurance_level END,
    version=version+1
  WHERE tenant_id=NEW.tenant_id AND id=NEW.accepted_subject_id AND email=NEW.email AND organization_id=NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation recipient mismatch'; END IF;
  INSERT INTO core.role_bindings(id, tenant_id, subject_id, role, organization_id, project_id, scope_kind, governance_scope)
  VALUES (gen_random_uuid(), NEW.tenant_id, NEW.accepted_subject_id, NEW.invited_role,
    CASE WHEN NEW.invited_role <> 'administrator' AND NEW.invited_project_id IS NULL THEN NEW.organization_id END,
    NEW.invited_project_id, CASE WHEN NEW.invited_role='administrator' THEN 'tenant' ELSE 'organization' END, 'none');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.apply_invited_workspace_role() FROM PUBLIC;
CREATE TRIGGER apply_invited_workspace_role AFTER UPDATE OF state ON core.invitations
FOR EACH ROW WHEN (OLD.state='pending' AND NEW.state='accepted' AND NEW.invited_role IS NOT NULL)
EXECUTE FUNCTION core.apply_invited_workspace_role();
