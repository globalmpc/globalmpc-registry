-- A recovery belongs to the original holder session. Checking for an admin
-- decision must not refresh that session's idle deadline.
CREATE FUNCTION core.wallet_recovery_session_live(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,core,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.wallet_recoveries r
    JOIN core.sessions s ON s.id=r.session_id AND s.tenant_id=r.tenant_id AND s.subject_id=r.subject_id
    JOIN core.subjects holder ON holder.id=r.subject_id AND holder.tenant_id=r.tenant_id
    WHERE r.id=p_id AND r.tenant_id=core.current_tenant() AND holder.email=r.email AND NOT s.recovery_limited
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND COALESCE(s.last_seen_at, s.issued_at) > now() - interval '30 minutes'
    AND s.first_factor <> 'siwe_legacy'
    AND s.subject_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM core.subjects x WHERE x.id = s.subject_id AND x.suspended_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM core.session_factor_proofs p
      LEFT JOIN core.webauthn_credentials c ON c.id = p.webauthn_credential_id
      LEFT JOIN core.totp_authenticators t ON t.id = p.totp_authenticator_id
      WHERE p.id = s.second_factor_proof_id
        AND (c.revoked_at IS NOT NULL OR t.revoked_at IS NOT NULL)
    )
    -- 0132 (F1): a Google / Microsoft session stands on the identity its transaction completed
    -- with; once that identity is revoked (or gone), the session does not resolve.
    AND (s.oidc_transaction_id IS NULL OR EXISTS (
      SELECT 1
      FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = s.oidc_transaction_id AND i.revoked_at IS NULL
    ))
  )
$$;
REVOKE ALL ON FUNCTION core.wallet_recovery_session_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.wallet_recovery_session_live(uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.approve_wallet_recovery(p_session uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,core,pg_temp AS $$
DECLARE actor core.sessions := core.mfa_lock_session(p_session);
BEGIN
  IF actor.recovery_limited OR NOT EXISTS (SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id
    WHERE b.tenant_id=actor.tenant_id AND b.subject_id=actor.subject_id AND b.role='administrator' AND b.revoked_at IS NULL
      AND b.project_id IS NULL AND s.kind='person' AND s.suspended_at IS NULL) THEN RETURN false; END IF;
  UPDATE core.wallet_recoveries SET approved_by=actor.subject_id, approved_at=now() WHERE id=p_id AND tenant_id=actor.tenant_id
    AND cancelled_at IS NULL AND consumed_at IS NULL AND approved_by IS NULL AND confirmed_at IS NOT NULL
    AND created_at>now()-interval '24 hours' AND core.wallet_recovery_session_live(p_id);
  RETURN FOUND;
END $$;
