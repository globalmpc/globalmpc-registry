-- Identity: Google issuer + subject for return visits. Authority for a new account:
-- an unexpired pending invitation matching Google's currently authoritative email.
-- Tenant and organization come exclusively from the invitation. Roles are assigned separately.
-- Session completion rechecks and locks the live invitation before creating an account.
CREATE FUNCTION core.match_google_workspace_invitation(
  p_transaction UUID, p_issuer TEXT, p_subject_key TEXT, p_verified_email TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = core, pg_temp
SET row_security = off
AS $$
DECLARE
  flow core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction, 'sign_in');
  invitation core.invitations;
BEGIN
  IF flow.provider <> 'google' OR p_issuer <> 'https://accounts.google.com'
     OR p_verified_email IS NULL THEN RETURN NULL; END IF;

  -- Even a previously revoked link must never be resurrected by an email match.
  IF EXISTS (SELECT 1 FROM core.external_identities WHERE provider = 'google'
             AND issuer = p_issuer AND subject_key = p_subject_key) THEN RETURN NULL; END IF;
  SELECT * INTO invitation FROM core.invitations
    WHERE email = core.normalize_email(p_verified_email) AND state = 'pending' AND expires_at > now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE core.oidc_login_transactions SET purpose = 'invitation_accept',
    tenant_id = invitation.tenant_id, invitation_id = invitation.id,
    display_name = 'Registry member' WHERE id = flow.id;
  RETURN invitation.id;
END
$$;
REVOKE ALL ON FUNCTION core.match_google_workspace_invitation(UUID,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.match_google_workspace_invitation(UUID,TEXT,TEXT,TEXT) TO mpc_app;
