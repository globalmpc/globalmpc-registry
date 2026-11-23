-- Microsoft sign-in is removed.
--
-- Google and the emailed code stay the ways in. Microsoft (0120–0121) is taken out of the
-- database rather than left switched off: its rows, its enum values, the `idp_tenant` column
-- that only a Microsoft identity filled, and the function parameters that carried it.
--
-- | Question | Decision |
-- | --- | --- |
-- | Identity namespace | Only Google `(iss = https://accounts.google.com, sub)` remains. `core.oidc_provider` is `google` alone; `core.session_first_factor` loses `microsoft` (it keeps `siwe_legacy`, whose revoked sessions are history). |
-- | Authority | A Microsoft identity no longer signs anyone in: its sessions, login transactions and identities are deleted here, before the type is rebuilt. Nothing else changes who may sign in or link. |
-- | Frozen vs live state | Signed records, audit events and role bindings are untouched; an audit event that names `microsoft` stays as written. A queued email notice that lists a removed sign-in names only Google from now on. |
-- | Input scope | Every row whose provider or first factor is `microsoft`, in any state, live or revoked. |
-- | Status priority | Fail closed: if a wallet recovery was opened from a Microsoft session, the migration stops instead of cascading the recovery record away. An operator resolves that recovery first. |
--
-- Old API builds stop working against this schema (the completion functions lose their
-- `p_idp_tenant` argument). That is intended: no rolling compatibility with older releases.

-- 1. Keep the recovery record history: refuse rather than delete it through the cascade.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM core.wallet_recoveries r JOIN core.sessions s ON s.id = r.session_id
    WHERE s.first_factor = 'microsoft'
  ) THEN
    RAISE EXCEPTION 'a wallet recovery was opened from a Microsoft session; resolve it before removing Microsoft sign-in';
  END IF;
END
$$;

-- 2. Microsoft rows. Sessions first (they name the login transaction they completed), then the
--    transactions (they name the identity), then the identities. Challenges and factor proofs of
--    a deleted session go with it (ON DELETE CASCADE).
DELETE FROM core.sessions WHERE first_factor = 'microsoft';
DELETE FROM core.oidc_login_transactions WHERE provider = 'microsoft';
DELETE FROM core.external_identities WHERE provider = 'microsoft';

-- A pending notice that lists the sign-ins a recovery removed keeps only the names that still
-- exist; the jobs worker accepts nothing else.
UPDATE core.email_outbox
SET params = jsonb_set(params, '{removedSignIns}', COALESCE((
  SELECT jsonb_agg(entry) FROM jsonb_array_elements(params -> 'removedSignIns') AS entry
  WHERE entry <> to_jsonb('microsoft'::text)
), '[]'::jsonb))
WHERE state = 'pending' AND jsonb_typeof(params -> 'removedSignIns') = 'array'
  AND params -> 'removedSignIns' @> to_jsonb(ARRAY['microsoft'::text]);


-- 3. Every function whose signature or result names either type, or whose body still mentions
--    Microsoft, is dropped here and created again below on the new types.

DROP FUNCTION core.create_subject_session(uuid,text,uuid,core.session_first_factor,core.session_second_factor,integer);
DROP FUNCTION core.lock_external_identity(core.oidc_provider,text,text);
DROP FUNCTION core.list_external_identities(uuid);
DROP FUNCTION core.subject_sign_in_providers(uuid[]);
DROP FUNCTION core.list_own_sessions(uuid);
DROP FUNCTION core.claim_oidc_transaction(text,text,core.oidc_provider,uuid);
DROP FUNCTION core.complete_oidc_invitation(uuid,text,text,text,text,text,uuid,uuid,uuid,text,integer);
DROP FUNCTION core.complete_oidc_link(uuid,uuid,text,text,text,text,uuid,text);
DROP FUNCTION core.insert_oidc_session(uuid,core.oidc_provider,uuid,uuid,text,integer);
DROP FUNCTION core.start_oidc_transaction(uuid,core.oidc_provider,core.oidc_purpose,text,text,text,bytea,text,uuid,text,text,text);
DROP FUNCTION core.complete_oidc_link(uuid,uuid,text,text,text,text,uuid);
DROP FUNCTION core.wallet_recovery_session_live(uuid);
DROP FUNCTION core.resolve_session(text);

-- 4. Constraints and triggers that name either column's type or `idp_tenant`.
ALTER TABLE core.external_identities DROP CONSTRAINT external_identities_issuer;
ALTER TABLE core.sessions
  DROP CONSTRAINT sessions_subject_required,
  DROP CONSTRAINT sessions_wallet_only_for_legacy,
  DROP CONSTRAINT sessions_legacy_single_factor,
  DROP CONSTRAINT sessions_email_code_has_challenge,
  DROP CONSTRAINT sessions_oidc_has_transaction,
  DROP CONSTRAINT sessions_no_live_wallet_login;
DROP TRIGGER sessions_email_challenge_consumed ON core.sessions;
DROP TRIGGER sessions_oidc_transaction_completed ON core.sessions;

ALTER TABLE core.external_identities DROP COLUMN idp_tenant;

-- 5. The types, rebuilt without `microsoft`.
ALTER TYPE core.oidc_provider RENAME TO oidc_provider_0171;
CREATE TYPE core.oidc_provider AS ENUM ('google');
ALTER TABLE core.external_identities
  ALTER COLUMN provider TYPE core.oidc_provider USING provider::text::core.oidc_provider;
ALTER TABLE core.oidc_login_transactions
  ALTER COLUMN provider TYPE core.oidc_provider USING provider::text::core.oidc_provider;
DROP TYPE core.oidc_provider_0171;

ALTER TYPE core.session_first_factor RENAME TO session_first_factor_0171;
CREATE TYPE core.session_first_factor AS ENUM ('email_code', 'google', 'siwe_legacy');
ALTER TABLE core.sessions
  ALTER COLUMN first_factor TYPE core.session_first_factor USING first_factor::text::core.session_first_factor;
DROP TYPE core.session_first_factor_0171;

-- 6. The same rules again, Google only.
ALTER TABLE core.external_identities ADD CONSTRAINT external_identities_issuer
  CHECK (provider = 'google' AND issuer = 'https://accounts.google.com');
ALTER TABLE core.sessions
  ADD CONSTRAINT sessions_subject_required
    CHECK (subject_id IS NOT NULL OR first_factor = 'siwe_legacy'),
  ADD CONSTRAINT sessions_wallet_only_for_legacy
    CHECK ((first_factor = 'siwe_legacy') = (wallet_address IS NOT NULL AND chain_id IS NOT NULL)),
  ADD CONSTRAINT sessions_legacy_single_factor
    CHECK (first_factor <> 'siwe_legacy' OR second_factor IS NULL),
  ADD CONSTRAINT sessions_email_code_has_challenge
    CHECK ((first_factor = 'email_code') = (email_challenge_id IS NOT NULL)),
  ADD CONSTRAINT sessions_oidc_has_transaction
    CHECK ((first_factor = 'google') = (oidc_transaction_id IS NOT NULL)),
  ADD CONSTRAINT sessions_no_live_wallet_login
    CHECK (first_factor <> 'siwe_legacy' OR revoked_at IS NOT NULL);
CREATE TRIGGER sessions_email_challenge_consumed
  BEFORE INSERT OR UPDATE OF email_challenge_id, subject_id, first_factor ON core.sessions
  FOR EACH ROW EXECUTE FUNCTION core.session_email_challenge_consumed();
CREATE TRIGGER sessions_oidc_transaction_completed
  BEFORE INSERT OR UPDATE OF oidc_transaction_id, subject_id, first_factor ON core.sessions
  FOR EACH ROW EXECUTE FUNCTION core.session_oidc_transaction_completed();

-- 7. The functions, on the new types. `complete_oidc_invitation` and `complete_oidc_link` lose
--    `p_idp_tenant`; `list_external_identities` no longer returns it. The seven-argument
--    `complete_oidc_link` (before 0156 added `p_verified_email`) had no caller and is not
--    recreated. Bodies are otherwise unchanged.

CREATE OR REPLACE FUNCTION core.create_subject_session(p_id uuid, p_token_hash text, p_subject_id uuid, p_first_factor core.session_first_factor, p_second_factor core.session_second_factor, p_ttl_seconds integer)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
BEGIN
  IF p_second_factor IS NOT NULL THEN
    RAISE EXCEPTION 'a session starts at its first factor; a second factor is recorded only when its proof is consumed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_first_factor = 'siwe_legacy' THEN
    RAISE EXCEPTION 'a wallet session is created by core.create_wallet_session'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_first_factor = 'email_code' THEN
    RAISE EXCEPTION 'an email-code session is created only by the function that consumes the code'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'a % session is created only by the function that completes its login transaction', p_first_factor
    USING ERRCODE = 'check_violation';
END
$function$;
REVOKE EXECUTE ON FUNCTION core.create_subject_session(uuid,text,uuid,core.session_first_factor,core.session_second_factor,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.lock_external_identity(p_provider core.oidc_provider, p_issuer text, p_subject_key text)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended('mpc-oidc-identity:' || p_provider || ':' || p_issuer || ':' || p_subject_key, 0))
$function$;
REVOKE EXECUTE ON FUNCTION core.lock_external_identity(core.oidc_provider,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.list_external_identities(p_session_id uuid)
 RETURNS TABLE(id uuid, provider core.oidc_provider, issuer text, linked_via text, created_at timestamp with time zone, last_used_at timestamp with time zone, revoked_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT i.id, i.provider, i.issuer, i.linked_via, i.created_at, i.last_used_at, i.revoked_at
  FROM core.sessions s
  JOIN core.external_identities i ON i.subject_id = s.subject_id
  WHERE s.id = p_session_id AND s.subject_id = core.current_actor()
    AND s.revoked_at IS NULL AND s.expires_at > now()
  ORDER BY i.created_at DESC
  LIMIT 50
$function$;
REVOKE EXECUTE ON FUNCTION core.list_external_identities(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.list_external_identities(uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.subject_sign_in_providers(p_subject_ids uuid[])
 RETURNS TABLE(subject_id uuid, provider core.oidc_provider)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT DISTINCT i.subject_id, i.provider
  FROM core.external_identities i
  WHERE i.subject_id = ANY(p_subject_ids)
    AND i.revoked_at IS NULL
    AND (SELECT core.actor_live())
  ORDER BY i.subject_id, i.provider
$function$;
REVOKE EXECUTE ON FUNCTION core.subject_sign_in_providers(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.subject_sign_in_providers(uuid[]) TO mpc_app;

CREATE OR REPLACE FUNCTION core.list_own_sessions(p_session_id uuid)
 RETURNS TABLE(session_id uuid, first_factor core.session_first_factor, second_factor core.session_second_factor, issued_at timestamp with time zone, last_seen_at timestamp with time zone, expires_at timestamp with time zone, is_current boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_subject UUID;
BEGIN
  SELECT s.subject_id INTO v_subject FROM core.sessions s
  WHERE s.id = p_session_id AND s.subject_id = core.current_actor()
    AND s.revoked_at IS NULL
    AND s.expires_at > now();
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'MFA_SESSION_INVALID: no live session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.id, s.first_factor, s.second_factor, s.issued_at, s.last_seen_at, s.expires_at,
         s.id = p_session_id
  FROM core.sessions s
  WHERE s.subject_id = v_subject
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
$function$;
REVOKE EXECUTE ON FUNCTION core.list_own_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.list_own_sessions(uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.claim_oidc_transaction(p_state_hash text, p_binding_hash text, p_provider core.oidc_provider, p_session_id uuid)
 RETURNS TABLE(status text, transaction_id uuid, purpose core.oidc_purpose, secret bytea, nonce_hash text, redirect_uri text, invitation_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions;
BEGIN
  SELECT * INTO v FROM core.oidc_login_transactions t WHERE t.state_hash = p_state_hash FOR UPDATE;
  IF NOT FOUND
     OR v.claimed_at IS NOT NULL
     OR v.provider <> p_provider
     OR NOT core.digest_equal(decode(v.binding_hash, 'hex'), decode(p_binding_hash, 'hex'))
     OR (v.purpose = 'link') <> (p_session_id IS NOT NULL)
     OR (v.purpose = 'link' AND v.session_id <> p_session_id) THEN
    RETURN QUERY SELECT 'state_invalid'::TEXT, NULL::UUID, NULL::core.oidc_purpose, NULL::BYTEA,
      NULL::TEXT, NULL::TEXT,NULL::UUID;
    RETURN;
  END IF;

  UPDATE core.oidc_login_transactions SET claimed_at = now(), secret_ciphertext = NULL WHERE id = v.id;

  IF v.expires_at <= now() THEN
    RETURN QUERY SELECT 'state_expired'::TEXT, v.id, v.purpose, NULL::BYTEA, NULL::TEXT, NULL::TEXT,v.invitation_id;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'claimed'::TEXT, v.id, v.purpose, v.secret_ciphertext, v.nonce_hash,
    v.redirect_uri,v.invitation_id;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.claim_oidc_transaction(text,text,core.oidc_provider,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.claim_oidc_transaction(text,text,core.oidc_provider,uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_oidc_invitation(p_transaction_id uuid, p_issuer text, p_subject_key text, p_verified_email text, p_email_hash text, p_identity_id uuid, p_subject_id uuid, p_session_id uuid, p_token_hash text, p_ttl_seconds integer)
 RETURNS TABLE(status text, subject_id uuid, organization_id uuid, invitation_id uuid, identity_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'invitation_accept');
  v_invitation core.invitations%ROWTYPE;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_invitation FROM core.invitations i
  WHERE i.id = v.invitation_id AND i.state = 'pending' AND i.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.oidc_complete(v.id, 'invitation_invalid', NULL, NULL);
    RETURN QUERY SELECT 'invitation_invalid'::TEXT,NULL::UUID, NULL::UUID, v.invitation_id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_verified_email IS NULL OR core.normalize_email(p_verified_email) <> v_invitation.email THEN
    PERFORM core.oidc_complete(v.id, 'email_mismatch', NULL, NULL);
    RETURN QUERY SELECT 'email_mismatch'::TEXT,NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_external_identity(v.provider, p_issuer, p_subject_key);
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
      AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL);
    RETURN QUERY SELECT 'identity_unavailable'::TEXT,NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_invitation.email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v_invitation.email) THEN
    UPDATE core.invitations SET state = 'expired', version = version + 1 WHERE id = v_invitation.id;
    PERFORM core.oidc_complete(v.id, 'email_unavailable', NULL, NULL);
    RETURN QUERY SELECT 'email_unavailable'::TEXT,NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO core.subjects (id,kind, display_name, assurance_level, email, organization_id)
  VALUES (p_subject_id,'person', v.display_name, 'wallet_only',
          v_invitation.email, v_invitation.organization_id);
  UPDATE core.invitations
  SET state = 'accepted', accepted_at = now(), accepted_subject_id = p_subject_id, version = version + 1
  WHERE id = v_invitation.id;
  -- A code still out for this invitation can no longer accept it.
  UPDATE core.email_challenges SET superseded_at = now()
  WHERE invitation_id = v_invitation.id AND consumed_at IS NULL AND superseded_at IS NULL;
  UPDATE core.email_outbox
  SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
  WHERE invitation_id = v_invitation.id AND template = 'invitation_code' AND state = 'pending';

  INSERT INTO core.external_identities (
    id,subject_id, provider, issuer, subject_key, email_hash, linked_via, last_used_at
  ) VALUES (
    p_identity_id,p_subject_id, v.provider, p_issuer, p_subject_key,
    p_email_hash, 'invitation', now()
  );
  PERFORM core.oidc_complete(v.id, 'session', p_subject_id, p_identity_id);
  v_expires := core.insert_oidc_session(
    v.id, v.provider, p_subject_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT,p_subject_id,
    v_invitation.organization_id, v_invitation.id, p_identity_id, v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.complete_oidc_invitation(uuid,text,text,text,text,uuid,uuid,uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_oidc_invitation(uuid,text,text,text,text,uuid,uuid,uuid,text,integer) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_oidc_link(p_transaction_id uuid, p_session_id uuid, p_issuer text, p_subject_key text, p_email_hash text, p_identity_id uuid, p_verified_email text)
 RETURNS TABLE(status text, identity_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET row_security TO 'off'
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_session core.sessions := core.mfa_lock_session(p_session_id);
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'link');
BEGIN
  IF v.session_id <> v_session.id OR v.subject_id <> v_session.subject_id THEN
    RAISE EXCEPTION 'OIDC_TRANSACTION_INVALID: the transaction belongs to another session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_session.recovery_limited THEN
    PERFORM core.oidc_complete(v.id, 'step_up_required', NULL, NULL);
    RETURN QUERY SELECT 'step_up_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = v_session.subject_id
      AND s.email = core.normalize_email(p_verified_email) AND s.suspended_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL);
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  PERFORM core.lock_external_identity(v.provider, p_issuer, p_subject_key);
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
      AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL);
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.subject_id = v_session.subject_id AND i.provider = v.provider AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'provider_already_linked', NULL, NULL);
    RETURN QUERY SELECT 'provider_already_linked'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO core.external_identities (
    id,subject_id, provider, issuer, subject_key, email_hash, linked_via
  ) VALUES (
    p_identity_id,v_session.subject_id, v.provider, p_issuer, p_subject_key,
    p_email_hash, 'link'
  );
  PERFORM core.oidc_complete(v.id, 'linked', NULL, p_identity_id);
  RETURN QUERY SELECT 'linked'::TEXT, p_identity_id;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.complete_oidc_link(uuid,uuid,text,text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_oidc_link(uuid,uuid,text,text,text,uuid,text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.insert_oidc_session(p_transaction_id uuid, p_provider core.oidc_provider, p_subject_id uuid, p_session_id uuid, p_token_hash text, p_ttl_seconds integer)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO core.sessions (
    id, token_hash,subject_id, first_factor, oidc_transaction_id, expires_at
  ) VALUES (
    p_session_id, p_token_hash,p_subject_id,
    p_provider::text::core.session_first_factor, p_transaction_id,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.insert_oidc_session(uuid,core.oidc_provider,uuid,uuid,text,integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.start_oidc_transaction(p_id uuid, p_provider core.oidc_provider, p_purpose core.oidc_purpose, p_state_hash text, p_binding_hash text, p_nonce_hash text, p_secret bytea, p_redirect_uri text, p_session_id uuid, p_invitation_token_hash text, p_display_name text, p_ip_key text)
 RETURNS TABLE(status text, retry_after_seconds integer, subject_id uuid, invitation_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_now TIMESTAMPTZ := now();
  v_session core.sessions;
  v_invitation core.invitations%ROWTYPE;
  v_subject UUID;
BEGIN
  v_retry := core.take_auth_rate('oidc_start', 'ip:' || p_ip_key, 30, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_purpose = 'link' THEN
    IF p_session_id IS NULL OR p_invitation_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a link names the caller''s session and nothing else' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_session FROM core.sessions s
    WHERE s.id = p_session_id AND s.subject_id = core.current_actor()
      AND s.revoked_at IS NULL AND s.expires_at > now() AND s.first_factor <> 'siwe_legacy';
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'session_invalid'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    IF v_session.recovery_limited THEN
      RETURN QUERY SELECT 'step_up_required'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    v_subject := v_session.subject_id;
  ELSIF p_purpose = 'invitation_accept' THEN
    IF p_session_id IS NOT NULL OR p_display_name IS NULL THEN
      RAISE EXCEPTION 'an invitation acceptance names an invitation and a display name' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_invitation FROM core.invitations i
    WHERE i.token_hash = p_invitation_token_hash AND i.state = 'pending' AND i.expires_at > now();
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invitation_invalid'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
  ELSE
    IF p_session_id IS NOT NULL OR p_invitation_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a sign-in names no session and no invitation' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  INSERT INTO core.oidc_login_transactions (
    id, provider, purpose, state_hash, binding_hash, nonce_hash, secret_ciphertext, redirect_uri,subject_id, session_id, invitation_id, display_name, created_at, expires_at
  ) VALUES (
    p_id, p_provider, p_purpose, p_state_hash, p_binding_hash, p_nonce_hash, p_secret, p_redirect_uri,v_subject, CASE WHEN p_purpose = 'link' THEN p_session_id END,
    v_invitation.id, CASE WHEN p_purpose = 'invitation_accept' THEN p_display_name END,
    v_now, v_now + interval '10 minutes'
  );
  RETURN QUERY SELECT 'started'::TEXT, 0,v_subject, v_invitation.id, v_now + interval '10 minutes';
END
$function$;
REVOKE EXECUTE ON FUNCTION core.start_oidc_transaction(uuid,core.oidc_provider,core.oidc_purpose,text,text,text,bytea,text,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.start_oidc_transaction(uuid,core.oidc_provider,core.oidc_purpose,text,text,text,bytea,text,uuid,text,text,text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.wallet_recovery_session_live(p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM core.wallet_recoveries r
    JOIN core.sessions s ON s.id=r.session_id AND s.subject_id=r.subject_id
    JOIN core.subjects holder ON holder.id=r.subject_id
    WHERE r.id=p_id AND holder.email=r.email AND NOT s.recovery_limited
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
    -- 0132 (F1): a Google session stands on the identity its transaction completed
    -- with; once that identity is revoked (or gone), the session does not resolve.
    AND (s.oidc_transaction_id IS NULL OR EXISTS (
      SELECT 1
      FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = s.oidc_transaction_id AND i.revoked_at IS NULL
    ))
  )
$function$;
REVOKE EXECUTE ON FUNCTION core.wallet_recovery_session_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.wallet_recovery_session_live(uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.resolve_session(p_token_hash text)
 RETURNS TABLE(session_id uuid, subject_id uuid, first_factor core.session_first_factor, second_factor core.session_second_factor, second_factor_at timestamp with time zone, recovery_limited boolean, assurance_level core.assurance_level, expires_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  UPDATE core.sessions s
  SET last_seen_at = now()
  WHERE s.token_hash = p_token_hash
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
    -- 0132 (F1): a Google session stands on the identity its transaction completed
    -- with; once that identity is revoked (or gone), the session does not resolve.
    AND (s.oidc_transaction_id IS NULL OR EXISTS (
      SELECT 1
      FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = s.oidc_transaction_id AND i.revoked_at IS NULL
    ))
  RETURNING
    s.id, s.subject_id, s.first_factor, s.second_factor, s.second_factor_at,
    s.recovery_limited,
    (SELECT subject.assurance_level FROM core.subjects subject WHERE subject.id = s.subject_id),
    s.expires_at
$function$;
REVOKE EXECUTE ON FUNCTION core.resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_session(text) TO mpc_app;

