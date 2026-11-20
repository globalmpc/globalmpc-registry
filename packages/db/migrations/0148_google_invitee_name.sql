-- Preserve the previous signature while older API instances finish during rollout.
CREATE FUNCTION core.match_google_workspace_invitation(
  p_transaction UUID, p_issuer TEXT, p_subject_key TEXT, p_verified_email TEXT, p_profile_name TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = core, pg_temp
SET row_security = off
AS $$
DECLARE
  invitation UUID := core.match_google_workspace_invitation(p_transaction, p_issuer, p_subject_key, p_verified_email);
BEGIN
  IF invitation IS NOT NULL THEN
    -- Names are presentation data. Never reuse the private email address as a public label.
    UPDATE core.oidc_login_transactions SET display_name = CASE
      WHEN length(trim(p_profile_name)) BETWEEN 1 AND 200 AND p_profile_name !~ '[[:cntrl:]@]'
        THEN trim(p_profile_name)
      ELSE 'Invited member ' || invitation::text
    END WHERE id = p_transaction;
  END IF;
  RETURN invitation;
END
$$;
REVOKE ALL ON FUNCTION core.match_google_workspace_invitation(UUID,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.match_google_workspace_invitation(UUID,TEXT,TEXT,TEXT,TEXT) TO mpc_app;
