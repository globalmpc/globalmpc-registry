-- A person's own sessions — account authentication follow-up to WP6.
--
-- The settings screen lists where the account is signed in and ends one of those sessions. The
-- application role holds no privilege on `core.sessions` (0108), so both go through functions that
-- take the **caller's** session id and act only on sessions of that session's subject, in the
-- current tenant:
--
-- | Call | Caller session | Target | Result |
-- | --- | --- | --- | --- |
-- | list | live, current tenant | — | the subject's live sessions (not revoked, not expired, not idle 30 min); no token hash |
-- | revoke | live, current tenant, aal2+, not recovery-limited | a live session of the same subject | `revoked`, reason `revoked_by_holder` |
-- | revoke | same | a session of the same subject that already ended | `already_ended` — nothing changes |
-- | revoke | same | another subject's session, another tenant's, or no such id | `unknown` — the same answer for all three |
--
-- Revoking needs aal2, the level of the other self-service account changes that end sessions
-- (wallet disable, 0122). It does not need the strongest factor held: ending a session only takes
-- access away, and a person who suspects a stolen session must be able to end it from any device
-- that passed a second factor. The caller may end its own session too; that is a sign-out.

/**
 * The caller subject's live sessions. "Live" is what `core.resolve_session` would accept, minus
 * the authenticator check: a session whose factor was revoked no longer resolves and is not
 * listed either.
 */
CREATE FUNCTION core.list_own_sessions(p_session_id UUID)
RETURNS TABLE (
  session_id    UUID,
  first_factor  core.session_first_factor,
  second_factor core.session_second_factor,
  issued_at     TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  is_current    BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_subject UUID;
BEGIN
  SELECT s.subject_id INTO v_subject FROM core.sessions s
  WHERE s.id = p_session_id
    AND s.tenant_id = core.current_tenant()
    AND s.revoked_at IS NULL
    AND s.expires_at > now();
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'MFA_SESSION_INVALID: no live session in the current tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.id, s.first_factor, s.second_factor, s.issued_at, s.last_seen_at, s.expires_at,
         s.id = p_session_id
  FROM core.sessions s
  WHERE s.subject_id = v_subject
    AND s.tenant_id = core.current_tenant()
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND COALESCE(s.last_seen_at, s.issued_at) > now() - interval '30 minutes'
    AND s.first_factor <> 'siwe_legacy'
    AND NOT EXISTS (
      SELECT 1
      FROM core.session_factor_proofs p
      LEFT JOIN core.webauthn_credentials c ON c.id = p.webauthn_credential_id
      LEFT JOIN core.totp_authenticators t ON t.id = p.totp_authenticator_id
      WHERE p.id = s.second_factor_proof_id
        AND (c.revoked_at IS NOT NULL OR t.revoked_at IS NOT NULL)
    )
  ORDER BY s.issued_at DESC, s.id;
END
$$;

/**
 * Ends one session of the caller's subject. Locks subject then session (`core.mfa_lock_session`),
 * the order every account function uses.
 */
CREATE FUNCTION core.revoke_own_session(p_session_id UUID, p_target_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_target core.sessions;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, false);

  SELECT * INTO v_target FROM core.sessions s
  WHERE s.id = p_target_id AND s.subject_id = v.subject_id AND s.tenant_id = v.tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;
  IF v_target.revoked_at IS NOT NULL OR v_target.expires_at <= now() THEN
    RETURN 'already_ended';
  END IF;

  UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'revoked_by_holder'
  WHERE id = v_target.id;
  RETURN 'revoked';
END
$$;

REVOKE EXECUTE ON FUNCTION core.list_own_sessions(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.revoke_own_session(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.list_own_sessions(UUID) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.revoke_own_session(UUID, UUID) TO mpc_app;
