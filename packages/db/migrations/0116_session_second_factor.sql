-- Second factors — account authentication WP3: a session's factor rests on a consumed proof.
--
-- 0108 recorded `second_factor` as whatever the caller of `core.create_subject_session` said, and
-- asked the second-factor work to bind it to evidence. Here:
--
-- 1. `core.sessions.second_factor_proof_id` references the proof (0115) the factor rests on,
--    by `(proof, session, factor)`. A session claims a factor only with a proof row of that
--    factor **for that session**, and a passkey proof exists only for a WebAuthn challenge this
--    session consumed. That is a constraint on the table: no function, and no role that can
--    write the table, can record `passkey` without a consumed assertion.
-- 2. `core.create_subject_session` refuses a second factor. A session starts at its first
--    factor (aal1) and is raised only by the functions below, each of which consumes its
--    evidence — challenge, TOTP step, recovery code — in the same transaction that raises it.
--    Sessions already holding an unproven second factor are deleted: they claim what nothing
--    proved. (In practice only test databases have them; no MFA flow existed before this.)
-- 3. `core.sessions.recovery_limited` — a session restored by a recovery code may only enrol a
--    new passkey or TOTP and sign out until it proves a real factor.
--    The API enforces the route allowlist; the functions below enforce it for what they do.
--    Proving that factor completes the recovery and ends every session of the subject, the
--    recovering one included (plan journey 5): the person signs in again with the new factor.
-- 4. `core.resolve_session` also refuses a session whose proof's authenticator has since been
--    revoked (plan §3 priority rule 1), and returns `recovery_limited`.
--
-- **What the database cannot check:** a WebAuthn signature or a TOTP code. The API verifies them
-- (`@simplewebauthn/server`, `otpauth`) before calling these functions; the functions make the
-- result single-use, bound to the session and subject that asked, inside the tenant, and
-- consistent with the enrolment rules. The functions are the API role's only path: it holds no
-- grant on sessions, challenges or proofs.
--
-- **Enrolment rules** (`core.mfa_enrolment_verdict`, evaluated with the subject row locked so two
-- concurrent enrolments cannot both see "no factor yet"):
--
-- | Session | Subject holds | May enrol |
-- | --- | --- | --- |
-- | recovery-limited | anything | a passkey, or a TOTP that replaces the current one |
-- | aal1 | a passkey or TOTP | nothing (`MFA_STEP_UP_REQUIRED`) |
-- | aal1 | none, created < 24 h ago or an approved reset window open | its first factor |
-- | aal1 | none, otherwise | nothing (`MFA_ENROLMENT_WINDOW_CLOSED`, needs an admin reset) |
-- | aal2 | a passkey | no passkey (`MFA_PASSKEY_REQUIRED`); a TOTP if it has none |
-- | aal2 / aal3 | otherwise | a passkey; a TOTP if it has none (`MFA_TOTP_ALREADY_ENROLLED`) |
--
-- **Removal**: needs the level of the strongest factor the subject holds (aal3 while any passkey
-- is active, else aal2), never removes the last passkey-or-TOTP (`MFA_LAST_FACTOR`), and revokes
-- every other session of the subject.

-- ---------------------------------------------------------------------------
-- 1–3. Session columns
-- ---------------------------------------------------------------------------

-- Same handling as 0108: sessions force RLS on their owner, so a migration role that does not
-- bypass it lifts FORCE for this statement and puts it back.
DO $$
DECLARE
  lift BOOLEAN := NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('row_security', 'off', true);
  IF lift THEN
    ALTER TABLE core.sessions NO FORCE ROW LEVEL SECURITY;
  END IF;

  DELETE FROM core.sessions WHERE second_factor IS NOT NULL;

  IF lift THEN
    ALTER TABLE core.sessions FORCE ROW LEVEL SECURITY;
  END IF;
  PERFORM set_config('row_security', 'on', true);
  PERFORM set_config('lock_timeout', '0', true);
END
$$;

ALTER TABLE core.sessions
  ADD COLUMN second_factor_proof_id UUID,
  ADD COLUMN recovery_limited BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT sessions_second_factor_proven
    CHECK ((second_factor IS NULL) = (second_factor_proof_id IS NULL)),
  ADD CONSTRAINT sessions_second_factor_proof
    FOREIGN KEY (second_factor_proof_id, id, second_factor)
    REFERENCES core.session_factor_proofs (id, session_id, factor),
  -- A recovery code restores a limited session, always, and nothing else is limited.
  ADD CONSTRAINT sessions_recovery_limited_shape
    CHECK (recovery_limited = COALESCE(second_factor = 'recovery_code', false));

/**
 * Creates a session for a subject that proved an account first factor, at aal1.
 *
 * The 0113 body (same signature, so callers and grants carry over) with one more refusal:
 * `p_second_factor` must be NULL, because a second factor is recorded only by the functions
 * below, after its evidence is consumed. 0113's refusals stay: no wallet session (that is
 * `core.create_wallet_session`) and no `email_code` session (only the function that consumes the
 * code creates one, 0114; the 0113 CHECK and trigger hold that at the table as well).
 */
CREATE OR REPLACE FUNCTION core.create_subject_session(
  p_id UUID,
  p_token_hash TEXT,
  p_subject_id UUID,
  p_first_factor core.session_first_factor,
  p_second_factor core.session_second_factor,
  p_ttl_seconds INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_tenant UUID;
  v_expires TIMESTAMPTZ;
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
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tenant_id INTO v_tenant FROM core.subjects WHERE id = p_subject_id AND kind = 'person';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no person subject %', p_subject_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_tenant IS DISTINCT FROM core.current_tenant() THEN
    RAISE EXCEPTION 'subject % is not in the current tenant', p_subject_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, expires_at)
  VALUES (p_id, p_token_hash, v_tenant, p_subject_id, p_first_factor,
          now() + make_interval(secs => p_ttl_seconds))
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Resolution
-- ---------------------------------------------------------------------------

DROP FUNCTION core.resolve_session(TEXT);

/**
 * 0108's resolver, plus: a session whose second factor was proved with a passkey or TOTP that is
 * now revoked no longer resolves (priority rule 1 — removal and admin reset end it), and the
 * recovery limit is returned for the API's route allowlist.
 */
CREATE FUNCTION core.resolve_session(p_token_hash TEXT)
RETURNS TABLE (
  session_id       UUID,
  subject_id       UUID,
  tenant_id        UUID,
  first_factor     core.session_first_factor,
  second_factor    core.session_second_factor,
  second_factor_at TIMESTAMPTZ,
  recovery_limited BOOLEAN,
  wallet_address   TEXT,
  chain_id         INTEGER,
  assurance_level  core.assurance_level,
  expires_at       TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
  UPDATE core.sessions s
  SET last_seen_at = now()
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND COALESCE(s.last_seen_at, s.issued_at) > now() - interval '30 minutes'
    AND (
      s.first_factor <> 'siwe_legacy'
      OR s.subject_id IS NULL
      OR EXISTS (
        SELECT 1 FROM core.wallet_identities w
        WHERE w.subject_id = s.subject_id
          AND w.wallet_address = s.wallet_address
          AND w.chain_id = s.chain_id
          AND w.disabled_at IS NULL
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM core.session_factor_proofs p
      LEFT JOIN core.webauthn_credentials c ON c.id = p.webauthn_credential_id
      LEFT JOIN core.totp_authenticators t ON t.id = p.totp_authenticator_id
      WHERE p.id = s.second_factor_proof_id
        AND (c.revoked_at IS NOT NULL OR t.revoked_at IS NOT NULL)
    )
  RETURNING
    s.id, s.subject_id, s.tenant_id, s.first_factor, s.second_factor, s.second_factor_at,
    s.recovery_limited, s.wallet_address, s.chain_id,
    -- As 0108: a legacy wallet session is held to the lower of the subject's and the signing
    -- wallet's level.
    (
      SELECT CASE
        WHEN s.first_factor = 'siwe_legacy' THEN LEAST(
          subject.assurance_level,
          (
            SELECT w.assurance_level FROM core.wallet_identities w
            WHERE w.subject_id = s.subject_id
              AND w.wallet_address = s.wallet_address
              AND w.chain_id = s.chain_id
              AND w.disabled_at IS NULL
          )
        )
        ELSE subject.assurance_level
      END
      FROM core.subjects subject WHERE subject.id = s.subject_id
    ),
    s.expires_at
$$;

REVOKE EXECUTE ON FUNCTION core.resolve_session(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_session(TEXT) TO mpc_app;

-- ---------------------------------------------------------------------------
-- Internal helpers (not granted: callable only from the functions below)
-- ---------------------------------------------------------------------------

/**
 * Locks the caller's live account session and its subject. Every MFA function starts here, so
 * the session and subject rows serialize concurrent ceremonies of one person.
 */
CREATE FUNCTION core.mfa_lock_session(p_session_id UUID) RETURNS core.sessions
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions;
BEGIN
  SELECT * INTO v FROM core.sessions
  WHERE id = p_session_id
    AND tenant_id = core.current_tenant()
    AND revoked_at IS NULL
    AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_SESSION_INVALID: no live session in the current tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A wallet signature carries no second factor (0108 `sessions_legacy_single_factor`); legacy
  -- sessions go when wallet sign-in is removed and do not enrol.
  IF v.first_factor = 'siwe_legacy' THEN
    RAISE EXCEPTION 'MFA_LEGACY_SESSION: a wallet session has no second factor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM core.subjects WHERE id = v.subject_id FOR UPDATE;
  RETURN v;
END
$$;

/** 1 = first factor only, 2 = TOTP or recovery code, 3 = passkey — as `deriveAuthenticationLevel`. */
CREATE FUNCTION core.mfa_session_rank(v core.sessions) RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = core, pg_temp
AS $$
  SELECT CASE v.second_factor WHEN 'passkey' THEN 3 WHEN 'totp' THEN 2 WHEN 'recovery_code' THEN 2 ELSE 1 END
$$;

CREATE FUNCTION core.mfa_has_passkey(p_subject_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.webauthn_credentials WHERE subject_id = p_subject_id AND revoked_at IS NULL
  )
$$;

CREATE FUNCTION core.mfa_has_totp(p_subject_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.totp_authenticators
    WHERE subject_id = p_subject_id AND confirmed_at IS NOT NULL AND revoked_at IS NULL
  )
$$;

/**
 * Whether an approved admin reset (0117) has an enrolment window open for the subject. Defined
 * here against the table of 0115 so the verdict below has no forward reference.
 */
CREATE FUNCTION core.mfa_reset_window_open(p_subject_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.mfa_reset_requests
    WHERE subject_id = p_subject_id AND state = 'approved' AND enrolment_window_until > now()
  )
$$;

/** The enrolment rules in the header table. `allowed`, or the refusal code. */
CREATE FUNCTION core.mfa_enrolment_verdict(v core.sessions, p_kind TEXT) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_passkey BOOLEAN := core.mfa_has_passkey(v.subject_id);
  v_totp BOOLEAN := core.mfa_has_totp(v.subject_id);
  v_created TIMESTAMPTZ;
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
    SELECT created_at INTO v_created FROM core.subjects WHERE id = v.subject_id;
    IF v_created > now() - interval '24 hours' OR core.mfa_reset_window_open(v.subject_id) THEN
      RETURN 'allowed';
    END IF;
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

CREATE FUNCTION core.mfa_assert_enrolment(v core.sessions, p_kind TEXT) RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_verdict TEXT := core.mfa_enrolment_verdict(v, p_kind);
BEGIN
  IF v_verdict <> 'allowed' THEN
    RAISE EXCEPTION '%: this session may not enrol a % now', v_verdict, p_kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

/**
 * Records the proof and raises the session to it. Called with the evidence already consumed in
 * this transaction. A passkey is never lowered to TOTP: callers pass a weaker factor only when
 * the session holds no stronger one.
 */
CREATE FUNCTION core.mfa_raise_session(
  v core.sessions,
  p_factor core.session_second_factor,
  p_challenge UUID,
  p_credential UUID,
  p_totp UUID,
  p_step BIGINT,
  p_recovery_code UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_proof UUID := gen_random_uuid();
BEGIN
  INSERT INTO core.session_factor_proofs (
    id, tenant_id, subject_id, session_id, factor, webauthn_challenge_id, webauthn_credential_id,
    totp_authenticator_id, totp_step, recovery_code_id
  ) VALUES (
    v_proof, v.tenant_id, v.subject_id, v.id, p_factor, p_challenge, p_credential, p_totp, p_step,
    p_recovery_code
  );
  UPDATE core.sessions
  SET second_factor = p_factor,
      second_factor_at = now(),
      second_factor_proof_id = v_proof,
      -- A recovery code limits the session; any real factor proved afterwards lifts the limit.
      recovery_limited = (p_factor = 'recovery_code')
  WHERE id = v.id;
  -- Journey 5 (plan, clarified 2026-11-02): a recovering session that proves a real factor has
  -- finished the recovery, and then every session of the subject ends — this one too. The person
  -- signs in again with the new factor, so nothing the recovery code opened outlives it.
  IF v.recovery_limited AND p_factor <> 'recovery_code' THEN
    PERFORM core.mfa_revoke_other_sessions(v, NULL, 'recovery_completed');
    RETURN true;
  END IF;
  RETURN false;
END
$$;

/** Stores ten new recovery codes when the subject has none left. Returns whether it did. */
CREATE FUNCTION core.mfa_store_recovery_codes(v core.sessions, p_hashes TEXT[], p_only_if_none BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_set UUID := gen_random_uuid();
BEGIN
  IF p_only_if_none AND EXISTS (
    SELECT 1 FROM core.recovery_codes
    WHERE subject_id = v.subject_id AND consumed_at IS NULL AND voided_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  IF p_hashes IS NULL
     OR cardinality(p_hashes) <> 10
     OR (SELECT count(DISTINCT h) FROM unnest(p_hashes) AS h) <> 10 THEN
    RAISE EXCEPTION 'a recovery code set is exactly ten distinct codes' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.recovery_codes SET voided_at = now()
  WHERE subject_id = v.subject_id AND consumed_at IS NULL AND voided_at IS NULL;
  INSERT INTO core.recovery_codes (id, tenant_id, subject_id, set_id, code_hash)
  SELECT gen_random_uuid(), v.tenant_id, v.subject_id, v_set, h FROM unnest(p_hashes) AS h;
  RETURN true;
END
$$;

/** Ends the subject's other sessions — or all of them with `p_keep` NULL. Returns how many. */
CREATE FUNCTION core.mfa_revoke_other_sessions(v core.sessions, p_keep UUID, p_reason TEXT) RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = p_reason
  WHERE subject_id = v.subject_id AND tenant_id = v.tenant_id AND revoked_at IS NULL
    AND id IS DISTINCT FROM p_keep;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ---------------------------------------------------------------------------
-- Status (read) and WebAuthn challenges
-- ---------------------------------------------------------------------------

/**
 * What the session's subject holds and may enrol — for the MFA screen. Reads nothing secret.
 */
CREATE FUNCTION core.mfa_status(p_session_id UUID)
RETURNS TABLE (
  passkey_enrolled         BOOLEAN,
  totp_enrolled            BOOLEAN,
  recovery_codes_remaining INTEGER,
  recovery_limited         BOOLEAN,
  passkey_enrolment        TEXT,
  totp_enrolment           TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
BEGIN
  RETURN QUERY SELECT
    core.mfa_has_passkey(v.subject_id),
    core.mfa_has_totp(v.subject_id),
    (SELECT count(*)::int FROM core.recovery_codes
     WHERE subject_id = v.subject_id AND consumed_at IS NULL AND voided_at IS NULL),
    v.recovery_limited,
    core.mfa_enrolment_verdict(v, 'passkey'),
    core.mfa_enrolment_verdict(v, 'totp');
END
$$;

/**
 * Issues a WebAuthn challenge for this session: registration only when the enrolment rules allow
 * a passkey now, authentication only when the subject holds one. Replaces any unspent challenge
 * of the same purpose, so a session has at most one live ceremony of each kind.
 */
CREATE FUNCTION core.create_webauthn_challenge(
  p_session_id UUID,
  p_purpose core.webauthn_challenge_purpose,
  p_challenge TEXT
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_expires TIMESTAMPTZ := now() + interval '5 minutes';
BEGIN
  IF p_purpose = 'registration' THEN
    PERFORM core.mfa_assert_enrolment(v, 'passkey');
  ELSIF NOT core.mfa_has_passkey(v.subject_id) THEN
    RAISE EXCEPTION 'MFA_NO_PASSKEY: the subject has no passkey' USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM core.webauthn_challenges
  WHERE session_id = v.id AND purpose = p_purpose AND consumed_at IS NULL;
  INSERT INTO core.webauthn_challenges (id, tenant_id, subject_id, session_id, purpose, challenge, expires_at)
  VALUES (gen_random_uuid(), v.tenant_id, v.subject_id, v.id, p_purpose, p_challenge, v_expires);
  RETURN v_expires;
END
$$;

/** The session's live challenge of that purpose, or NULL. The API verifies against it. */
CREATE FUNCTION core.live_webauthn_challenge(p_session_id UUID, p_purpose core.webauthn_challenge_purpose)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT challenge FROM core.webauthn_challenges
  WHERE session_id = p_session_id AND tenant_id = core.current_tenant() AND purpose = p_purpose
    AND consumed_at IS NULL AND expires_at > now()
$$;

/** Spends the session's challenge. Refused unless it is this session's, live and unspent. */
CREATE FUNCTION core.mfa_consume_challenge(
  v core.sessions,
  p_purpose core.webauthn_challenge_purpose,
  p_challenge TEXT
) RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE core.webauthn_challenges
  SET consumed_at = now(), consumed_by_session_id = v.id
  WHERE session_id = v.id AND tenant_id = v.tenant_id AND purpose = p_purpose
    AND challenge = p_challenge AND consumed_at IS NULL AND expires_at > now()
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'MFA_CHALLENGE_INVALID: no live % challenge of this session matches', p_purpose
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_id;
END
$$;

-- ---------------------------------------------------------------------------
-- Passkeys
-- ---------------------------------------------------------------------------

/**
 * Stores a passkey the API verified against this session's registration challenge, and raises
 * the session to `passkey` (registration required user verification, so it proved the same as an
 * assertion). Generates the first recovery code set when the subject has none.
 */
CREATE FUNCTION core.complete_webauthn_registration(
  p_session_id UUID,
  p_challenge TEXT,
  p_credential_id TEXT,
  p_public_key BYTEA,
  p_sign_count BIGINT,
  p_transports TEXT[],
  p_aaguid UUID,
  p_user_verified BOOLEAN,
  p_device_type TEXT,
  p_backed_up BOOLEAN,
  p_name TEXT,
  p_recovery_hashes TEXT[]
) RETURNS TABLE (passkey_id UUID, recovery_codes_stored BOOLEAN, session_ended BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge UUID;
  v_id UUID := gen_random_uuid();
  v_ended BOOLEAN;
  v_stored BOOLEAN;
BEGIN
  v_challenge := core.mfa_consume_challenge(v, 'registration', p_challenge);
  IF p_user_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'MFA_USER_VERIFICATION_REQUIRED: the authenticator did not verify the user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Checked again at completion: the subject may have gained a factor since the options.
  PERFORM core.mfa_assert_enrolment(v, 'passkey');

  BEGIN
    INSERT INTO core.webauthn_credentials (
      id, tenant_id, subject_id, credential_id, public_key, sign_count, transports, aaguid,
      user_verified, device_type, backed_up, name
    ) VALUES (
      v_id, v.tenant_id, v.subject_id, p_credential_id, p_public_key, p_sign_count,
      COALESCE(p_transports, '{}'), p_aaguid, p_user_verified, p_device_type, p_backed_up, p_name
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MFA_CREDENTIAL_EXISTS: this authenticator is already registered'
      USING ERRCODE = 'unique_violation';
  END;

  v_ended := core.mfa_raise_session(v, 'passkey', v_challenge, v_id, NULL, NULL, NULL);
  v_stored := core.mfa_store_recovery_codes(v, p_recovery_hashes, true);
  RETURN QUERY SELECT v_id, v_stored, v_ended;
END
$$;

/**
 * Accepts an assertion the API verified against this session's authentication challenge and the
 * subject's credential, and raises the session to `passkey` (aal3).
 *
 * Counter: a credential that has never counted (stored 0) may keep reporting 0 — synced passkeys
 * do. Once it has counted, the new value must be strictly greater; anything else is a regression
 * (a cloned authenticator) and is refused. Checked under the credential's row lock so two
 * assertions with the same counter cannot both pass.
 */
CREATE FUNCTION core.complete_webauthn_authentication(
  p_session_id UUID,
  p_challenge TEXT,
  p_credential_id TEXT,
  p_new_sign_count BIGINT,
  p_user_verified BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge UUID;
  v_credential core.webauthn_credentials;
BEGIN
  v_challenge := core.mfa_consume_challenge(v, 'authentication', p_challenge);
  IF p_user_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'MFA_USER_VERIFICATION_REQUIRED: the authenticator did not verify the user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_credential FROM core.webauthn_credentials
  WHERE credential_id = p_credential_id AND subject_id = v.subject_id AND tenant_id = v.tenant_id
    AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_CREDENTIAL_UNKNOWN: not an active passkey of this subject'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_new_sign_count IS NULL OR NOT (
    (p_new_sign_count = 0 AND v_credential.sign_count = 0) OR p_new_sign_count > v_credential.sign_count
  ) THEN
    RAISE EXCEPTION 'MFA_COUNTER_REGRESSION: the sign counter did not increase'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE core.webauthn_credentials SET sign_count = p_new_sign_count, last_used_at = now()
  WHERE id = v_credential.id;
  RETURN core.mfa_raise_session(v, 'passkey', v_challenge, v_credential.id, NULL, NULL, NULL);
END
$$;

CREATE FUNCTION core.rename_webauthn_credential(p_session_id UUID, p_passkey_id UUID, p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
BEGIN
  IF v.second_factor IS NULL OR v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_STEP_UP_REQUIRED: renaming a passkey needs a second factor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.webauthn_credentials SET name = p_name
  WHERE id = p_passkey_id AND subject_id = v.subject_id AND tenant_id = v.tenant_id AND revoked_at IS NULL;
  RETURN FOUND;
END
$$;

-- ---------------------------------------------------------------------------
-- TOTP
-- ---------------------------------------------------------------------------

/** Starts a TOTP setup: a pending row, confirmable for ten minutes. Replaces an earlier pending one. */
CREATE FUNCTION core.begin_totp_enrolment(
  p_id UUID,
  p_session_id UUID,
  p_ciphertext BYTEA,
  p_nonce BYTEA
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_expires TIMESTAMPTZ := now() + interval '10 minutes';
BEGIN
  PERFORM core.mfa_assert_enrolment(v, 'totp');
  UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'superseded'
  WHERE subject_id = v.subject_id AND confirmed_at IS NULL AND revoked_at IS NULL;
  INSERT INTO core.totp_authenticators (
    id, tenant_id, subject_id, secret_ciphertext, secret_nonce, pending_expires_at
  ) VALUES (p_id, v.tenant_id, v.subject_id, p_ciphertext, p_nonce, v_expires);
  RETURN v_expires;
END
$$;

/**
 * Counts one attempt against the subject's TOTP (`p_pending`: the setup being confirmed; else the
 * active one) and returns what the API needs to check a code. Refused once five attempts fell in
 * the current 15-minute window. Commit it before checking the code: the attempt stays counted
 * unless `core.complete_totp` accepts the code.
 */
CREATE FUNCTION core.reserve_totp_attempt(p_session_id UUID, p_pending BOOLEAN)
RETURNS TABLE (
  totp_id           UUID,
  secret_ciphertext BYTEA,
  secret_nonce      BYTEA,
  last_used_step    BIGINT,
  attempts_left     INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_row core.totp_authenticators;
BEGIN
  SELECT * INTO v_row FROM core.totp_authenticators t
  WHERE t.subject_id = v.subject_id AND t.tenant_id = v.tenant_id AND t.revoked_at IS NULL
    AND CASE WHEN p_pending THEN t.confirmed_at IS NULL AND t.pending_expires_at > now()
             ELSE t.confirmed_at IS NOT NULL END
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_TOTP_NOT_ENROLLED: no % TOTP for this subject',
      CASE WHEN p_pending THEN 'pending' ELSE 'active' END
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_row.failure_window_started_at IS NULL OR v_row.failure_window_started_at <= now() - interval '15 minutes' THEN
    v_row.failed_attempts := 0;
    v_row.failure_window_started_at := now();
  END IF;
  IF v_row.failed_attempts >= 5 THEN
    RAISE EXCEPTION 'MFA_TOTP_LOCKED: too many attempts; try again after %',
      to_char((v_row.failure_window_started_at + interval '15 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE core.totp_authenticators t
  SET failed_attempts = v_row.failed_attempts + 1, failure_window_started_at = v_row.failure_window_started_at
  WHERE t.id = v_row.id;

  RETURN QUERY SELECT v_row.id, v_row.secret_ciphertext, v_row.secret_nonce, v_row.last_used_step,
    4 - v_row.failed_attempts;
END
$$;

/**
 * Accepts a TOTP code the API verified for step `p_step`: refuses a step at or before the last
 * one accepted (replay), clears the attempt count, activates a pending setup (replacing the
 * current TOTP only for a recovery-limited session), and raises the session to `totp` unless it
 * already holds a passkey. Generates the first recovery code set when the subject has none.
 */
CREATE FUNCTION core.complete_totp(
  p_session_id UUID,
  p_totp_id UUID,
  p_step BIGINT,
  p_recovery_hashes TEXT[]
) RETURNS TABLE (activated BOOLEAN, recovery_codes_stored BOOLEAN, session_ended BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_row core.totp_authenticators;
  v_activated BOOLEAN := false;
  v_stored BOOLEAN := false;
  v_ended BOOLEAN := false;
BEGIN
  SELECT * INTO v_row FROM core.totp_authenticators
  WHERE id = p_totp_id AND subject_id = v.subject_id AND tenant_id = v.tenant_id AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_TOTP_NOT_ENROLLED: not a TOTP of this subject' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_step IS NULL OR p_step < 0 OR p_step <= COALESCE(v_row.last_used_step, -1) THEN
    RAISE EXCEPTION 'MFA_TOTP_REPLAYED: this code was already used' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_row.confirmed_at IS NULL THEN
    IF v_row.pending_expires_at <= now() THEN
      RAISE EXCEPTION 'MFA_TOTP_NOT_ENROLLED: the setup expired' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM core.mfa_assert_enrolment(v, 'totp');
    -- Only a recovery-limited session gets here with a TOTP already active: it replaces it.
    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'replaced_after_recovery'
    WHERE subject_id = v.subject_id AND confirmed_at IS NOT NULL AND revoked_at IS NULL;
    v_activated := true;
  END IF;

  UPDATE core.totp_authenticators
  SET confirmed_at = COALESCE(confirmed_at, now()), last_used_step = p_step, last_used_at = now(),
      failed_attempts = 0, failure_window_started_at = NULL
  WHERE id = v_row.id;

  IF v.second_factor IS DISTINCT FROM 'passkey' THEN
    v_ended := core.mfa_raise_session(v, 'totp', NULL, NULL, v_row.id, p_step, NULL);
  END IF;
  IF v_activated THEN
    v_stored := core.mfa_store_recovery_codes(v, p_recovery_hashes, true);
  END IF;
  RETURN QUERY SELECT v_activated, v_stored, v_ended;
END
$$;

-- ---------------------------------------------------------------------------
-- Recovery codes
-- ---------------------------------------------------------------------------

/**
 * Spends a recovery code from a first-factor-only session: the session becomes `recovery_code`
 * (aal2) and recovery-limited, and **every other** session of the subject ends. The recovering
 * session stays only until it proves a new (or found) factor — it is the only way left to enrol
 * one — and then ends with every other session (`core.mfa_raise_session`, plan journey 5).
 */
CREATE FUNCTION core.consume_recovery_code(p_session_id UUID, p_code_hash TEXT) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_code UUID;
BEGIN
  IF v.second_factor IS NOT NULL THEN
    RAISE EXCEPTION 'MFA_ALREADY_SATISFIED: this session already proved a second factor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.recovery_codes SET consumed_at = now(), consumed_by_session_id = v.id
  WHERE id = (
    SELECT id FROM core.recovery_codes
    WHERE subject_id = v.subject_id AND tenant_id = v.tenant_id AND code_hash = p_code_hash
      AND consumed_at IS NULL AND voided_at IS NULL
    LIMIT 1
    FOR UPDATE
  )
  RETURNING id INTO v_code;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'MFA_RECOVERY_CODE_INVALID: not a usable recovery code of this subject'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM core.mfa_raise_session(v, 'recovery_code', NULL, NULL, NULL, NULL, v_code);
  RETURN core.mfa_revoke_other_sessions(v, v.id, 'recovery_code_used');
END
$$;

/** Voids the unused codes and stores a new set of ten. Needs the strongest factor held; never a recovering session. */
CREATE FUNCTION core.regenerate_recovery_codes(p_session_id UUID, p_hashes TEXT[]) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_required INTEGER;
BEGIN
  -- A recovery code is a way to enrol any factor, a passkey included. Minting a fresh set is
  -- therefore worth what the strongest factor held is worth: otherwise a TOTP session could
  -- regenerate, spend one, and enrol its own passkey on an account that has one.
  IF v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_RECOVERY_REENROLMENT_REQUIRED: enrol a new factor first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_required := CASE WHEN core.mfa_has_passkey(v.subject_id) THEN 3 ELSE 2 END;
  IF core.mfa_session_rank(v) < v_required THEN
    RAISE EXCEPTION '%: regenerating recovery codes needs a session at aal%',
      CASE WHEN v_required = 3 THEN 'MFA_PASSKEY_REQUIRED' ELSE 'MFA_STEP_UP_REQUIRED' END, v_required
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN core.mfa_store_recovery_codes(v, p_hashes, false);
END
$$;

-- ---------------------------------------------------------------------------
-- Removal
-- ---------------------------------------------------------------------------

/**
 * Revokes one of the subject's passkeys (`p_kind = 'passkey'`, `p_id` its row id) or its TOTP
 * (`'totp'`, `p_id` ignored), and ends every other session of the subject. Returns how many
 * other sessions ended, and whether the current one did too — it does when its own proof used
 * the removed authenticator (`core.resolve_session` would refuse it anyway).
 */
CREATE FUNCTION core.remove_authenticator(p_session_id UUID, p_kind TEXT, p_id UUID)
RETURNS TABLE (revoked_sessions INTEGER, current_session_ended BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_target UUID;
  v_remaining INTEGER;
  v_required INTEGER;
  v_count INTEGER;
  v_ended BOOLEAN;
BEGIN
  IF v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_RECOVERY_REENROLMENT_REQUIRED: enrol a new factor first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_kind = 'passkey' THEN
    SELECT id INTO v_target FROM core.webauthn_credentials
    WHERE id = p_id AND subject_id = v.subject_id AND tenant_id = v.tenant_id AND revoked_at IS NULL
    FOR UPDATE;
  ELSIF p_kind = 'totp' THEN
    SELECT id INTO v_target FROM core.totp_authenticators
    WHERE subject_id = v.subject_id AND tenant_id = v.tenant_id AND confirmed_at IS NOT NULL
      AND revoked_at IS NULL
    FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unknown factor kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'MFA_AUTHENTICATOR_UNKNOWN: not an active % of this subject', p_kind
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The strongest factor the subject holds, the one being removed included: a TOTP-level session
  -- must not strip a passkey off the account.
  v_required := CASE WHEN core.mfa_has_passkey(v.subject_id) THEN 3 ELSE 2 END;
  IF core.mfa_session_rank(v) < v_required THEN
    RAISE EXCEPTION '%: removing a factor needs a session at aal%',
      CASE WHEN v_required = 3 THEN 'MFA_PASSKEY_REQUIRED' ELSE 'MFA_STEP_UP_REQUIRED' END, v_required
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_remaining := (SELECT count(*)::int FROM core.webauthn_credentials
                  WHERE subject_id = v.subject_id AND revoked_at IS NULL)
               + (CASE WHEN core.mfa_has_totp(v.subject_id) THEN 1 ELSE 0 END) - 1;
  IF v_remaining < 1 THEN
    RAISE EXCEPTION 'MFA_LAST_FACTOR: the last passkey or TOTP cannot be removed; an admin reset replaces it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_kind = 'passkey' THEN
    UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'removed_by_holder'
    WHERE id = v_target;
  ELSE
    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'removed_by_holder'
    WHERE id = v_target;
  END IF;

  v_count := core.mfa_revoke_other_sessions(v, v.id, 'authenticator_removed');
  v_ended := EXISTS (
    SELECT 1 FROM core.session_factor_proofs p
    WHERE p.id = v.second_factor_proof_id
      AND (p.webauthn_credential_id = v_target OR p.totp_authenticator_id = v_target)
  );
  IF v_ended THEN
    UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'authenticator_removed' WHERE id = v.id;
  END IF;
  RETURN QUERY SELECT v_count, v_ended;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  core.mfa_lock_session(UUID),
  core.mfa_session_rank(core.sessions),
  core.mfa_has_passkey(UUID),
  core.mfa_has_totp(UUID),
  core.mfa_reset_window_open(UUID),
  core.mfa_enrolment_verdict(core.sessions, TEXT),
  core.mfa_assert_enrolment(core.sessions, TEXT),
  core.mfa_raise_session(core.sessions, core.session_second_factor, UUID, UUID, UUID, BIGINT, UUID),
  core.mfa_store_recovery_codes(core.sessions, TEXT[], BOOLEAN),
  core.mfa_revoke_other_sessions(core.sessions, UUID, TEXT),
  core.mfa_consume_challenge(core.sessions, core.webauthn_challenge_purpose, TEXT),
  core.mfa_status(UUID),
  core.create_webauthn_challenge(UUID, core.webauthn_challenge_purpose, TEXT),
  core.live_webauthn_challenge(UUID, core.webauthn_challenge_purpose),
  core.complete_webauthn_registration(UUID, TEXT, TEXT, BYTEA, BIGINT, TEXT[], UUID, BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT[]),
  core.complete_webauthn_authentication(UUID, TEXT, TEXT, BIGINT, BOOLEAN),
  core.rename_webauthn_credential(UUID, UUID, TEXT),
  core.begin_totp_enrolment(UUID, UUID, BYTEA, BYTEA),
  core.reserve_totp_attempt(UUID, BOOLEAN),
  core.complete_totp(UUID, UUID, BIGINT, TEXT[]),
  core.consume_recovery_code(UUID, TEXT),
  core.regenerate_recovery_codes(UUID, TEXT[]),
  core.remove_authenticator(UUID, TEXT, UUID)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  core.mfa_status(UUID),
  core.create_webauthn_challenge(UUID, core.webauthn_challenge_purpose, TEXT),
  core.live_webauthn_challenge(UUID, core.webauthn_challenge_purpose),
  core.complete_webauthn_registration(UUID, TEXT, TEXT, BYTEA, BIGINT, TEXT[], UUID, BOOLEAN, TEXT, BOOLEAN, TEXT, TEXT[]),
  core.complete_webauthn_authentication(UUID, TEXT, TEXT, BIGINT, BOOLEAN),
  core.rename_webauthn_credential(UUID, UUID, TEXT),
  core.begin_totp_enrolment(UUID, UUID, BYTEA, BYTEA),
  core.reserve_totp_attempt(UUID, BOOLEAN),
  core.complete_totp(UUID, UUID, BIGINT, TEXT[]),
  core.consume_recovery_code(UUID, TEXT),
  core.regenerate_recovery_codes(UUID, TEXT[]),
  core.remove_authenticator(UUID, TEXT, UUID)
TO mpc_app;
