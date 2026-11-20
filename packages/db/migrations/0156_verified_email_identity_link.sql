ALTER FUNCTION core.start_oidc_transaction(uuid, core.oidc_provider, core.oidc_purpose, text, text, text, bytea, text, uuid, text, text, text) SET row_security = off;

CREATE FUNCTION core.complete_oidc_link(
  p_transaction_id UUID,
  p_session_id UUID,
  p_issuer TEXT,
  p_subject_key TEXT,
  p_idp_tenant TEXT,
  p_email_hash TEXT,
  p_identity_id UUID,
  p_verified_email TEXT
) RETURNS TABLE (status TEXT, identity_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET row_security = off
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

  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = v_session.subject_id AND s.tenant_id = v_session.tenant_id
      AND s.email = core.normalize_email(p_verified_email) AND s.suspended_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL, NULL);
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::UUID;
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

REVOKE ALL ON FUNCTION core.complete_oidc_link(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_oidc_link(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT) TO mpc_app;

-- Older application instances cannot attest to the missing proof.
CREATE OR REPLACE FUNCTION core.complete_oidc_link(
  p_transaction_id UUID,
  p_session_id UUID,
  p_issuer TEXT,
  p_subject_key TEXT,
  p_idp_tenant TEXT,
  p_email_hash TEXT,
  p_identity_id UUID
) RETURNS TABLE (status TEXT, identity_id UUID)
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog, core, pg_temp
AS $$ SELECT * FROM core.complete_oidc_link($1, $2, $3, $4, $5, $6, $7, NULL::text) $$;
