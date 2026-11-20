CREATE OR REPLACE FUNCTION core.create_role_invitation(p_id uuid, p_org uuid, p_email text, p_session uuid,
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
    SELECT 1 FROM core.projects WHERE tenant_id=actor.tenant_id AND id=p_project AND (p_role='reviewer' OR owner_organization_id=p_org)
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
