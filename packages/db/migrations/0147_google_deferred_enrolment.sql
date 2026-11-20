CREATE INDEX external_identities_identity_history_idx ON core.external_identities (provider, issuer, subject_key);

CREATE OR REPLACE FUNCTION core.mfa_enrolment_verdict(v core.sessions, p_kind TEXT) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_passkey BOOLEAN := core.mfa_has_passkey(v.subject_id);
  v_totp BOOLEAN := core.mfa_has_totp(v.subject_id);
BEGIN
  IF p_kind NOT IN ('passkey', 'totp') THEN
    RAISE EXCEPTION 'unknown factor kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Re-enrolment is what a recovery code is for; the code already revoked every other session.
  IF v.recovery_limited THEN
    RETURN 'allowed';
  END IF;
  IF v.second_factor IS NULL THEN
    -- Without this, anyone holding the first factor (a mailbox, an identity provider account)
    -- could add their own authenticator to an account that already has one.
    IF v_passkey OR v_totp THEN
      RETURN 'MFA_STEP_UP_REQUIRED';
    END IF;
    IF core.mfa_creation_window_open(v.subject_id) OR core.mfa_reset_window_open(v.subject_id) THEN
      RETURN 'allowed';
    END IF;
    -- A first-time Google invitee may defer setup until their first privileged task.
    -- Tie the exception to this session's original live invitation identity. Never
    -- reopen setup for someone who enrolled, recovered, changed address or was suspended.
    IF v.first_factor = 'google' AND EXISTS (
      SELECT 1 FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = v.oidc_transaction_id AND i.subject_id = v.subject_id
        AND i.tenant_id = v.tenant_id AND i.provider = 'google'
        AND i.linked_via = 'invitation' AND i.revoked_at IS NULL
    ) AND NOT EXISTS (SELECT 1 FROM core.webauthn_credentials WHERE subject_id = v.subject_id)
      AND NOT EXISTS (SELECT 1 FROM core.totp_authenticators WHERE subject_id = v.subject_id AND confirmed_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM core.recovery_codes WHERE subject_id = v.subject_id)
      AND NOT EXISTS (SELECT 1 FROM core.mfa_reset_requests WHERE subject_id = v.subject_id)
      AND NOT EXISTS (SELECT 1 FROM core.email_change_requests WHERE subject_id = v.subject_id AND state = 'completed')
      AND NOT EXISTS (SELECT 1 FROM core.subject_suspensions WHERE subject_id = v.subject_id AND action = 'suspend' AND state = 'approved')
    THEN RETURN 'allowed'; END IF;
    RETURN 'MFA_ENROLMENT_WINDOW_CLOSED';
  END IF;
  IF p_kind = 'passkey' AND v_passkey AND v.second_factor <> 'passkey' THEN
    RETURN 'MFA_PASSKEY_REQUIRED';
  END IF;
  IF p_kind = 'totp' AND v_totp THEN
    RETURN 'MFA_TOTP_ALREADY_ENROLLED';
  END IF;
  RETURN 'allowed';
END
$$;
