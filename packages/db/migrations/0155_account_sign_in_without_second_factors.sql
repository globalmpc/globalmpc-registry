CREATE OR REPLACE FUNCTION core.create_role_invitation(p_id uuid, p_org uuid, p_email text, p_session uuid,
  p_hash text, p_link text, p_role text, p_project uuid, p_basis text)
RETURNS TABLE(status text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp AS $$
DECLARE
  actor core.sessions := core.mfa_lock_session(p_session);
  result record;
BEGIN
  IF actor.recovery_limited OR NOT EXISTS (
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

CREATE OR REPLACE FUNCTION core.wallet_assert_session(v core.sessions, p_minimum INTEGER, p_strongest_held BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = core, pg_temp
AS $$
BEGIN
  IF v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_RECOVERY_REENROLMENT_REQUIRED: enrol a new factor first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION core.start_oidc_transaction(
  p_id UUID,
  p_provider core.oidc_provider,
  p_purpose core.oidc_purpose,
  p_state_hash TEXT,
  p_binding_hash TEXT,
  p_nonce_hash TEXT,
  p_secret BYTEA,
  p_redirect_uri TEXT,
  p_session_id UUID,
  p_invitation_token_hash TEXT,
  p_display_name TEXT,
  p_ip_key TEXT
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID, invitation_id UUID,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_now TIMESTAMPTZ := now();
  v_session core.sessions;
  v_invitation core.invitations%ROWTYPE;
  v_tenant UUID;
  v_subject UUID;
BEGIN
  v_retry := core.take_auth_rate('oidc_start', 'ip:' || p_ip_key, 30, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_purpose = 'link' THEN
    IF p_session_id IS NULL OR p_invitation_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a link names the caller''s session and nothing else' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_session FROM core.sessions s
    WHERE s.id = p_session_id AND s.tenant_id = core.current_tenant()
      AND s.revoked_at IS NULL AND s.expires_at > now() AND s.first_factor <> 'siwe_legacy';
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'session_invalid'::TEXT, 0, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    IF v_session.recovery_limited THEN
      RETURN QUERY SELECT 'step_up_required'::TEXT, 0, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    v_tenant := v_session.tenant_id;
    v_subject := v_session.subject_id;
  ELSIF p_purpose = 'invitation_accept' THEN
    IF p_session_id IS NOT NULL OR p_display_name IS NULL THEN
      RAISE EXCEPTION 'an invitation acceptance names an invitation and a display name' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_invitation FROM core.invitations i
    WHERE i.token_hash = p_invitation_token_hash AND i.state = 'pending' AND i.expires_at > now();
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invitation_invalid'::TEXT, 0, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    v_tenant := v_invitation.tenant_id;
  ELSE
    IF p_session_id IS NOT NULL OR p_invitation_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a sign-in names no session and no invitation' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  INSERT INTO core.oidc_login_transactions (
    id, provider, purpose, state_hash, binding_hash, nonce_hash, secret_ciphertext, redirect_uri,
    tenant_id, subject_id, session_id, invitation_id, display_name, created_at, expires_at
  ) VALUES (
    p_id, p_provider, p_purpose, p_state_hash, p_binding_hash, p_nonce_hash, p_secret, p_redirect_uri,
    v_tenant, v_subject, CASE WHEN p_purpose = 'link' THEN p_session_id END,
    v_invitation.id, CASE WHEN p_purpose = 'invitation_accept' THEN p_display_name END,
    v_now, v_now + interval '10 minutes'
  );
  RETURN QUERY SELECT 'started'::TEXT, 0, v_tenant, v_subject, v_invitation.id, v_now + interval '10 minutes';
END
$$;

CREATE OR REPLACE FUNCTION core.complete_oidc_link(
  p_transaction_id UUID,
  p_session_id UUID,
  p_issuer TEXT,
  p_subject_key TEXT,
  p_idp_tenant TEXT,
  p_email_hash TEXT,
  p_identity_id UUID
) RETURNS TABLE (status TEXT, identity_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_session core.sessions := core.mfa_lock_session(p_session_id);
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'link');
BEGIN
  IF v.session_id <> v_session.id OR v.tenant_id <> v_session.tenant_id OR v.subject_id <> v_session.subject_id THEN
    RAISE EXCEPTION 'OIDC_TRANSACTION_INVALID: the transaction belongs to another session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_session.recovery_limited THEN
    PERFORM core.oidc_complete(v.id, 'step_up_required', NULL, NULL, NULL);
    RETURN QUERY SELECT 'step_up_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  PERFORM core.lock_external_identity(v.provider, p_issuer, p_subject_key);
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
      AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL, NULL);
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.subject_id = v_session.subject_id AND i.provider = v.provider AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'provider_already_linked', NULL, NULL, NULL);
    RETURN QUERY SELECT 'provider_already_linked'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO core.external_identities (
    id, tenant_id, subject_id, provider, issuer, subject_key, idp_tenant, email_hash, linked_via
  ) VALUES (
    p_identity_id, v_session.tenant_id, v_session.subject_id, v.provider, p_issuer, p_subject_key,
    p_idp_tenant, p_email_hash, 'link'
  );
  PERFORM core.oidc_complete(v.id, 'linked', NULL, NULL, p_identity_id);
  RETURN QUERY SELECT 'linked'::TEXT, p_identity_id;
END
$$;

CREATE OR REPLACE FUNCTION core.unlink_external_identity(p_session_id UUID, p_identity_id UUID)
RETURNS TABLE (revoked_sessions INTEGER, current_session_ended BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_target core.external_identities;
  v_count INTEGER;
  v_ended BOOLEAN;
BEGIN
  IF v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_RECOVERY_REENROLMENT_REQUIRED: enrol a new factor first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_target FROM core.external_identities
  WHERE id = p_identity_id AND subject_id = v.subject_id AND tenant_id = v.tenant_id AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OIDC_IDENTITY_UNKNOWN: not a live identity of this subject'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM core.subjects WHERE id = v.subject_id AND email IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM core.external_identities
       WHERE subject_id = v.subject_id AND revoked_at IS NULL AND id <> v_target.id
     ) THEN
    RAISE EXCEPTION 'OIDC_LAST_SIGN_IN_METHOD: the last way to sign in cannot be unlinked'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE core.external_identities SET revoked_at = now(), revoked_reason = 'unlinked_by_holder'
  WHERE id = v_target.id;

  v_ended := EXISTS (
    SELECT 1 FROM core.oidc_login_transactions t
    WHERE t.id = v.oidc_transaction_id AND t.identity_id = v_target.id
  );
  UPDATE core.sessions s SET revoked_at = now(), revoked_reason = 'identity_unlinked'
  FROM core.oidc_login_transactions t
  WHERE s.oidc_transaction_id = t.id AND t.identity_id = v_target.id
    AND s.revoked_at IS NULL AND s.id <> v.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_ended THEN
    UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'identity_unlinked' WHERE id = v.id;
  END IF;
  RETURN QUERY SELECT v_count, v_ended;
END
$$;
-- Deployment migrates before old API tasks drain, and rollback may restart the old image.
-- Retain its existing factor grants until that image leaves the supported rollback window.
