-- Emailed-code sign-in, invitation acceptance and email change — account authentication WP2.
--
-- Every function here is SECURITY DEFINER for one of two reasons: before sign-in the tenant is
-- unknown (as in 0005/0108), or the rule spans tenants (an address is unique across all of them,
-- D6). Each takes exactly the inputs its step needs, pins `search_path`, and is granted to the
-- one role that calls it.
--
-- **The database decides, the API only computes.** The API generates the code and its HMAC (the
-- key never reaches the database) and passes both; the database stores the HMAC, queues the code
-- for mail, counts attempts and limits, compares in constant time, consumes the challenge and
-- creates the session in one transaction. An `email_code` session therefore cannot be created by
-- a caller that merely asserts the factor (0113's constraint and trigger).
--
-- **Outcomes are returned, not raised.** A wrong code must still count as an attempt and a
-- request over the limit must still be refused next time, so these functions return a status and
-- let the caller's transaction commit.
--
-- Limits (per 15 minutes; refused requests are not counted):
--
-- | Action | Per address (keyed hash) or flow | Per requester IP (keyed hash) |
-- | --- | --- | --- |
-- | Ask for a code | 5 | 20 |
-- | Check a code | 10 | 50 |
--
-- plus 5 attempts per code. With 8 digits that is at most 10 guesses per address per 15 minutes
-- against 10^8 codes.

-- ---------------------------------------------------------------------------
-- Building blocks (granted to nobody; called by the functions below)
-- ---------------------------------------------------------------------------

/** Equality of two digests in time that depends only on their length. */
CREATE FUNCTION core.digest_equal(p_a BYTEA, p_b BYTEA) RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_diff INTEGER := 0;
BEGIN
  IF p_a IS NULL OR p_b IS NULL OR length(p_a) <> length(p_b) THEN
    RETURN false;
  END IF;
  FOR i IN 0 .. length(p_a) - 1 LOOP
    v_diff := v_diff | (get_byte(p_a, i) # get_byte(p_b, i));
  END LOOP;
  RETURN v_diff = 0;
END
$$;

/**
 * Counts one request against a limit. Returns 0 when it is allowed (and recorded), otherwise the
 * seconds until the oldest counted request leaves the window.
 *
 * The advisory lock serialises requests for the same bucket, so two replicas cannot both read
 * "4 of 5" and both pass.
 */
CREATE FUNCTION core.take_auth_rate(
  p_action TEXT, p_bucket TEXT, p_limit INTEGER, p_window INTERVAL
) RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_count INTEGER;
  v_oldest TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mpc-auth-rate:' || p_action || ':' || p_bucket, 0));
  SELECT count(*), min(occurred_at) INTO v_count, v_oldest
  FROM core.auth_rate_events
  WHERE action = p_action AND bucket = p_bucket AND occurred_at > now() - p_window;
  IF v_count >= p_limit THEN
    RETURN GREATEST(1, ceil(extract(epoch FROM (v_oldest + p_window - now())))::INTEGER);
  END IF;
  INSERT INTO core.auth_rate_events (action, bucket) VALUES (p_action, p_bucket);
  RETURN 0;
END
$$;

/** Serialises everything that decides who holds an address: invite, accept, change. */
CREATE FUNCTION core.lock_email(p_email TEXT) RETURNS VOID
LANGUAGE sql
VOLATILE
SET search_path = core, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('mpc-email:' || p_email, 0))
$$;

/**
 * Whether an address is taken anywhere: by a subject, an open invitation or an open email change,
 * in any tenant. Expired invitations and stale approved changes are flipped first so they do not
 * hold an address forever. Call with the address locked (`core.lock_email`).
 */
CREATE FUNCTION core.email_in_use(p_email TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
BEGIN
  UPDATE core.invitations SET state = 'expired', version = version + 1
  WHERE email = p_email AND state = 'pending' AND expires_at <= now();
  UPDATE core.email_change_requests SET state = 'expired', version = version + 1
  WHERE new_email = p_email AND state = 'approved' AND decided_at <= now() - interval '72 hours';
  RETURN EXISTS (SELECT 1 FROM core.subjects WHERE email = p_email)
      OR EXISTS (SELECT 1 FROM core.invitations WHERE email = p_email AND state = 'pending')
      OR EXISTS (
        SELECT 1 FROM core.email_change_requests
        WHERE new_email = p_email AND state IN ('pending', 'approved')
      );
END
$$;

/** Ends the live challenge for a purpose and address, and drops its unsent mail. */
CREATE FUNCTION core.supersede_email_challenge(
  p_purpose core.email_challenge_purpose, p_email TEXT
) RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  WITH ended AS (
    UPDATE core.email_challenges SET superseded_at = now()
    WHERE purpose = p_purpose AND email = p_email AND consumed_at IS NULL AND superseded_at IS NULL
    RETURNING id
  )
  SELECT array_agg(id) INTO v_ids FROM ended;
  IF v_ids IS NOT NULL THEN
    UPDATE core.email_outbox
    SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
    WHERE challenge_id = ANY (v_ids) AND state = 'pending';
  END IF;
END
$$;

/**
 * Writes a challenge and its mail. `p_recipient` NULL makes the mail row `suppressed`: the decoy
 * for an address without an account, written the same way as a real one.
 */
CREATE FUNCTION core.issue_email_challenge(
  p_id UUID,
  p_purpose core.email_challenge_purpose,
  p_email TEXT,
  p_tenant_id UUID,
  p_subject_id UUID,
  p_invitation_id UUID,
  p_email_change_id UUID,
  p_code_hmac BYTEA,
  p_template TEXT,
  p_recipient TEXT,
  p_code TEXT
) RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_code !~ '^[0-9]{8}$' THEN
    RAISE EXCEPTION 'a code is 8 digits' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM core.supersede_email_challenge(p_purpose, p_email);
  INSERT INTO core.email_challenges (
    id, purpose, email, tenant_id, subject_id, invitation_id, email_change_id, code_hmac,
    created_at, expires_at
  ) VALUES (
    p_id, p_purpose, p_email, p_tenant_id, p_subject_id, p_invitation_id, p_email_change_id,
    p_code_hmac, v_now, v_now + interval '10 minutes'
  );
  INSERT INTO core.email_outbox (
    id, template, recipient, params, state, settled_at, expires_at, challenge_id, invitation_id
  ) VALUES (
    gen_random_uuid(), p_template, p_recipient,
    CASE WHEN p_recipient IS NULL THEN NULL
         ELSE jsonb_build_object('code', p_code, 'expiresMinutes', 10) END,
    CASE WHEN p_recipient IS NULL THEN 'suppressed' ELSE 'pending' END,
    CASE WHEN p_recipient IS NULL THEN v_now ELSE NULL END,
    v_now + interval '10 minutes', p_id, p_invitation_id
  );
END
$$;

/**
 * Checks a code against the live challenge for a purpose and address and, if it matches,
 * consumes it in this transaction. Status: `ok`, `code_invalid`, `code_expired`,
 * `attempts_exhausted`. A decoy never returns `ok`.
 */
CREATE FUNCTION core.consume_email_challenge(
  p_purpose core.email_challenge_purpose,
  p_email TEXT,
  p_invitation_id UUID,
  p_code_hmac BYTEA
) RETURNS TABLE (
  status TEXT, challenge_id UUID, tenant_id UUID, subject_id UUID, email_change_id UUID
)
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.email_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v FROM core.email_challenges c
  WHERE c.purpose = p_purpose AND c.email = p_email
    AND c.consumed_at IS NULL AND c.superseded_at IS NULL
    AND (p_invitation_id IS NULL OR c.invitation_id = p_invitation_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF v.expires_at <= now() THEN
    RETURN QUERY SELECT 'code_expired'::TEXT, v.id, v.tenant_id, v.subject_id, v.email_change_id;
    RETURN;
  END IF;
  IF v.attempts >= 5 THEN
    RETURN QUERY SELECT 'attempts_exhausted'::TEXT, v.id, v.tenant_id, v.subject_id, v.email_change_id;
    RETURN;
  END IF;

  UPDATE core.email_challenges SET attempts = attempts + 1 WHERE id = v.id;

  IF NOT core.digest_equal(v.code_hmac, p_code_hmac)
     OR (v.subject_id IS NULL AND v.purpose <> 'invitation') THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, v.id, v.tenant_id, v.subject_id, v.email_change_id;
    RETURN;
  END IF;

  UPDATE core.email_challenges
  SET consumed_at = now(), consumed_txid = pg_current_xact_id()
  WHERE id = v.id;
  RETURN QUERY SELECT 'ok'::TEXT, v.id, v.tenant_id, v.subject_id, v.email_change_id;
END
$$;

/** Inserts the session a consumed challenge proves. The 0113 trigger re-checks the binding. */
CREATE FUNCTION core.insert_email_code_session(
  p_challenge_id UUID, p_subject_id UUID, p_tenant_id UUID,
  p_session_id UUID, p_token_hash TEXT, p_ttl_seconds INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO core.sessions (
    id, token_hash, tenant_id, subject_id, first_factor, email_challenge_id, expires_at
  ) VALUES (
    p_session_id, p_token_hash, p_tenant_id, p_subject_id, 'email_code', p_challenge_id,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$$;

REVOKE EXECUTE ON FUNCTION core.digest_equal(BYTEA, BYTEA) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.take_auth_rate(TEXT, TEXT, INTEGER, INTERVAL) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.lock_email(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.email_in_use(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.supersede_email_challenge(core.email_challenge_purpose, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.issue_email_challenge(
  UUID, core.email_challenge_purpose, TEXT, UUID, UUID, UUID, UUID, BYTEA, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.consume_email_challenge(core.email_challenge_purpose, TEXT, UUID, BYTEA) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.insert_email_code_session(UUID, UUID, UUID, UUID, TEXT, INTEGER) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Asking for a code
-- ---------------------------------------------------------------------------

/**
 * Starts a challenge and queues its code — sign-in, invitation acceptance or email change.
 *
 * - `sign_in`: `p_email` is what the person typed. For an address without a person subject a
 *   decoy is written instead and nothing is mailed.
 * - `email_change`: `p_email` is the new address of an approved change. Without one, a decoy.
 * - `invitation`: the address is **the invitation's**, found by `p_invitation_token_hash`; what
 *   the caller sends as an address is ignored. A token that is unknown, used, revoked or expired
 *   gives `invitation_invalid`.
 *
 * Status: `issued` (for real and decoy alike), `rate_limited`, `invitation_invalid`. The tenant
 * and subject come back only so the API can audit a real issue; they never reach the requester.
 */
CREATE FUNCTION core.start_email_challenge(
  p_purpose core.email_challenge_purpose,
  p_email TEXT,
  p_invitation_token_hash TEXT,
  p_challenge_id UUID,
  p_code_hmac BYTEA,
  p_code TEXT,
  p_email_key TEXT,
  p_ip_key TEXT
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID,
  invitation_id UUID, email_change_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_email TEXT;
  v_tenant UUID;
  v_subject UUID;
  v_invitation core.invitations%ROWTYPE;
  v_change core.email_change_requests%ROWTYPE;
BEGIN
  v_retry := core.take_auth_rate('code_start', 'ip:' || p_ip_key, 20, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_purpose = 'invitation' THEN
    SELECT * INTO v_invitation FROM core.invitations i
    WHERE i.token_hash = p_invitation_token_hash AND i.state = 'pending' AND i.expires_at > now()
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invitation_invalid'::TEXT, 0, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
    v_retry := core.take_auth_rate('code_start', 'invitation:' || v_invitation.id, 5, interval '15 minutes');
    IF v_retry > 0 THEN
      RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
    PERFORM core.issue_email_challenge(
      p_challenge_id, 'invitation', v_invitation.email, v_invitation.tenant_id, NULL,
      v_invitation.id, NULL, p_code_hmac, 'invitation_code', v_invitation.email, p_code
    );
    RETURN QUERY SELECT 'issued'::TEXT, 0, v_invitation.tenant_id, NULL::UUID, v_invitation.id, NULL::UUID;
    RETURN;
  END IF;

  v_email := core.normalize_email(p_email);
  v_retry := core.take_auth_rate('code_start', 'email:' || p_email_key, 5, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_purpose = 'sign_in' THEN
    SELECT f.subject_id, f.tenant_id INTO v_subject, v_tenant FROM core.find_person_by_email(v_email) f;
    PERFORM core.issue_email_challenge(
      p_challenge_id, 'sign_in', v_email, v_tenant, v_subject, NULL, NULL, p_code_hmac,
      'sign_in_code', CASE WHEN v_subject IS NULL THEN NULL ELSE v_email END, p_code
    );
    RETURN QUERY SELECT 'issued'::TEXT, 0, v_tenant, v_subject, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- email_change
  SELECT * INTO v_change FROM core.email_change_requests r
  WHERE r.new_email = v_email AND r.state = 'approved' AND r.decided_at > now() - interval '72 hours';
  PERFORM core.issue_email_challenge(
    p_challenge_id, 'email_change', v_email, v_change.tenant_id, v_change.subject_id, NULL,
    v_change.id, p_code_hmac, 'email_change_code',
    CASE WHEN v_change.id IS NULL THEN NULL ELSE v_email END, p_code
  );
  RETURN QUERY SELECT 'issued'::TEXT, 0, v_change.tenant_id, v_change.subject_id, NULL::UUID, v_change.id;
END
$$;

-- ---------------------------------------------------------------------------
-- Signing in with a code
-- ---------------------------------------------------------------------------

/**
 * Checks a sign-in code and, if it is right, creates the `email_code` session it proves — in
 * one transaction, so nothing else can claim the challenge in between.
 *
 * Status: `session_created`, `rate_limited`, `code_invalid`, `code_expired`, `attempts_exhausted`.
 * A right code whose account no longer holds the address (it was changed after the code was
 * sent) is `code_invalid`: the code proved control of an address that is no longer the login.
 */
CREATE FUNCTION core.verify_sign_in_code(
  p_email TEXT,
  p_code_hmac BYTEA,
  p_email_key TEXT,
  p_ip_key TEXT,
  p_session_id UUID,
  p_token_hash TEXT,
  p_ttl_seconds INTEGER
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID,
  challenge_id UUID, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_email TEXT := core.normalize_email(p_email);
  r RECORD;
  v_expires TIMESTAMPTZ;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry = 0 THEN
    v_retry := core.take_auth_rate('code_verify', 'email:' || p_email_key, 10, interval '15 minutes');
  END IF;
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO r FROM core.consume_email_challenge('sign_in', v_email, NULL, p_code_hmac);
  IF r.status <> 'ok' THEN
    RETURN QUERY SELECT r.status, 0, r.tenant_id, r.subject_id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = r.subject_id AND s.tenant_id = r.tenant_id AND s.kind = 'person' AND s.email = v_email
  ) THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0, r.tenant_id, r.subject_id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_expires := core.insert_email_code_session(
    r.challenge_id, r.subject_id, r.tenant_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT, 0, r.tenant_id, r.subject_id, r.challenge_id, v_expires;
END
$$;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------

/**
 * Creates an invitation in the caller's tenant and queues the link to the invited address.
 *
 * Status `created`, or `unavailable` when the address belongs to a subject or an open
 * invitation or email change **in any tenant** — one answer for every reason (D6), so the admin
 * learns only that the address cannot be invited, not where it is used. `p_link` is the
 * acceptance URL with the token in it; it lives only in the queued mail until that is sent.
 */
CREATE FUNCTION core.create_invitation(
  p_id UUID,
  p_organization_id UUID,
  p_email TEXT,
  p_invited_by UUID,
  p_token_hash TEXT,
  p_link TEXT
) RETURNS TABLE (status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant UUID := core.current_tenant();
  v_email TEXT := core.normalize_email(p_email);
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'an invitation is created inside a tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.organizations o WHERE o.id = p_organization_id AND o.tenant_id = v_tenant) THEN
    RETURN QUERY SELECT 'organization_unknown'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s WHERE s.id = p_invited_by AND s.tenant_id = v_tenant AND s.kind = 'person'
  ) THEN
    RAISE EXCEPTION 'inviter % is not a person in the current tenant', p_invited_by
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM core.lock_email(v_email);
  IF core.email_in_use(v_email) THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO core.invitations (
    id, tenant_id, organization_id, email, invited_by_subject_id, token_hash, created_at, expires_at
  ) VALUES (
    p_id, v_tenant, p_organization_id, v_email, p_invited_by, p_token_hash,
    v_now, v_now + interval '72 hours'
  );
  INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at, invitation_id)
  VALUES (
    gen_random_uuid(), 'invitation_link', v_email,
    jsonb_build_object('link', p_link, 'expiresAt', to_char(
      (v_now + interval '72 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'
    )),
    'pending', v_now + interval '72 hours', p_id
  );
  RETURN QUERY SELECT 'created'::TEXT, v_now + interval '72 hours';
END
$$;

/**
 * Revokes a pending invitation of the caller's tenant: its link stops working, its unsent mail is
 * dropped and a code already sent for it stops working. Status `revoked`, `not_pending`,
 * `not_found`, `version_mismatch`.
 */
CREATE FUNCTION core.revoke_invitation(p_id UUID, p_revoked_by UUID, p_expected_version INTEGER)
RETURNS TABLE (status TEXT, version INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.invitations%ROWTYPE;
BEGIN
  SELECT * INTO v FROM core.invitations i
  WHERE i.id = p_id AND i.tenant_id = core.current_tenant()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::INTEGER;
    RETURN;
  END IF;
  IF v.version <> p_expected_version THEN
    RETURN QUERY SELECT 'version_mismatch'::TEXT, v.version;
    RETURN;
  END IF;
  IF v.state <> 'pending' OR v.expires_at <= now() THEN
    RETURN QUERY SELECT 'not_pending'::TEXT, v.version;
    RETURN;
  END IF;

  UPDATE core.invitations
  SET state = 'revoked', revoked_at = now(), revoked_by_subject_id = p_revoked_by, version = version + 1
  WHERE id = v.id;
  UPDATE core.email_challenges SET superseded_at = now()
  WHERE invitation_id = v.id AND consumed_at IS NULL AND superseded_at IS NULL;
  UPDATE core.email_outbox
  SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
  WHERE invitation_id = v.id AND state = 'pending';
  RETURN QUERY SELECT 'revoked'::TEXT, v.version + 1;
END
$$;

/**
 * Accepts an invitation: checks the code sent to the invited address, creates the person in the
 * invitation's tenant and organisation, marks the invitation used and creates an `email_code`
 * session — all in one transaction.
 *
 * The new subject has the lowest identity assurance and **no role**: roles come only through the
 * two-person role grant, so the session (aal1) reaches its own session view and MFA enrolment.
 *
 * Status: `session_created`, `rate_limited`, `invitation_invalid`, `code_invalid`,
 * `code_expired`, `attempts_exhausted`, `email_unavailable` (the address was taken elsewhere
 * after the invitation was made; the invitation is revoked by the system).
 */
CREATE FUNCTION core.accept_invitation(
  p_token_hash TEXT,
  p_code_hmac BYTEA,
  p_ip_key TEXT,
  p_subject_id UUID,
  p_display_name TEXT,
  p_session_id UUID,
  p_session_token_hash TEXT,
  p_ttl_seconds INTEGER
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID,
  organization_id UUID, invitation_id UUID, challenge_id UUID, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v core.invitations%ROWTYPE;
  r RECORD;
  v_expires TIMESTAMPTZ;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO v FROM core.invitations i
  WHERE i.token_hash = p_token_hash AND i.state = 'pending' AND i.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invitation_invalid'::TEXT, 0, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_retry := core.take_auth_rate('code_verify', 'invitation:' || v.id, 10, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, v.tenant_id, NULL::UUID, v.organization_id, v.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO r FROM core.consume_email_challenge('invitation', v.email, v.id, p_code_hmac);
  IF r.status <> 'ok' THEN
    RETURN QUERY SELECT r.status, 0, v.tenant_id, NULL::UUID, v.organization_id, v.id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_email(v.email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v.email) THEN
    UPDATE core.invitations
    SET state = 'expired', version = version + 1
    WHERE id = v.id;
    RETURN QUERY SELECT 'email_unavailable'::TEXT, 0, v.tenant_id, NULL::UUID, v.organization_id, v.id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level, email, organization_id)
  VALUES (p_subject_id, v.tenant_id, 'person', p_display_name, 'wallet_only', v.email, v.organization_id);

  UPDATE core.invitations
  SET state = 'accepted', accepted_at = now(), accepted_subject_id = p_subject_id, version = version + 1
  WHERE id = v.id;
  UPDATE core.email_challenges SET subject_id = p_subject_id WHERE id = r.challenge_id;

  v_expires := core.insert_email_code_session(
    r.challenge_id, p_subject_id, v.tenant_id, p_session_id, p_session_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT, 0, v.tenant_id, p_subject_id, v.organization_id, v.id, r.challenge_id, v_expires;
END
$$;

-- ---------------------------------------------------------------------------
-- Email change — journey 7
-- ---------------------------------------------------------------------------

/**
 * Proposes a new address for a subject of the caller's tenant.
 *
 * Status `created`, `subject_invalid` (no such person), `self` (the proposer is the subject),
 * `already_open` (the subject has an open change), or `unavailable` — one answer for every way
 * the address is taken, as for invitations.
 */
CREATE FUNCTION core.request_email_change(
  p_id UUID, p_subject_id UUID, p_new_email TEXT, p_reason TEXT, p_requested_by UUID
) RETURNS TABLE (status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant UUID := core.current_tenant();
  v_email TEXT := core.normalize_email(p_new_email);
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'an email change is requested inside a tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s WHERE s.id = p_subject_id AND s.tenant_id = v_tenant AND s.kind = 'person'
  ) THEN
    RETURN QUERY SELECT 'subject_invalid'::TEXT;
    RETURN;
  END IF;
  IF p_subject_id = p_requested_by THEN
    RETURN QUERY SELECT 'self'::TEXT;
    RETURN;
  END IF;

  -- Stale approvals of this subject end first, so they do not block a new request forever.
  UPDATE core.email_change_requests SET state = 'expired', version = version + 1
  WHERE subject_id = p_subject_id AND state = 'approved' AND decided_at <= now() - interval '72 hours';
  IF EXISTS (
    SELECT 1 FROM core.email_change_requests r
    WHERE r.subject_id = p_subject_id AND r.state IN ('pending', 'approved')
  ) THEN
    RETURN QUERY SELECT 'already_open'::TEXT;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_email);
  IF core.email_in_use(v_email) THEN
    RETURN QUERY SELECT 'unavailable'::TEXT;
    RETURN;
  END IF;

  INSERT INTO core.email_change_requests (
    id, tenant_id, subject_id, new_email, reason, requested_by_subject_id
  ) VALUES (p_id, v_tenant, p_subject_id, v_email, p_reason, p_requested_by);
  RETURN QUERY SELECT 'created'::TEXT;
END
$$;

/**
 * Decides a pending email change of the caller's tenant. On approval, the code to the new address
 * is issued in the same transaction.
 *
 * Status `approved`, `rejected`, `not_found`, `version_mismatch`, `not_pending`,
 * `self_approval` (the decider proposed it), `self_target` (the decider is the subject). The two
 * refusals are also CHECK constraints on the table.
 */
CREATE FUNCTION core.decide_email_change(
  p_id UUID,
  p_decided_by UUID,
  p_approve BOOLEAN,
  p_reason TEXT,
  p_expected_version INTEGER,
  p_challenge_id UUID,
  p_code_hmac BYTEA,
  p_code TEXT
) RETURNS TABLE (status TEXT, version INTEGER, subject_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.email_change_requests%ROWTYPE;
BEGIN
  SELECT * INTO v FROM core.email_change_requests r
  WHERE r.id = p_id AND r.tenant_id = core.current_tenant()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::INTEGER, NULL::UUID;
    RETURN;
  END IF;
  IF v.version <> p_expected_version THEN
    RETURN QUERY SELECT 'version_mismatch'::TEXT, v.version, v.subject_id;
    RETURN;
  END IF;
  IF v.state <> 'pending' THEN
    RETURN QUERY SELECT 'not_pending'::TEXT, v.version, v.subject_id;
    RETURN;
  END IF;
  IF v.requested_by_subject_id = p_decided_by THEN
    RETURN QUERY SELECT 'self_approval'::TEXT, v.version, v.subject_id;
    RETURN;
  END IF;
  IF v.subject_id = p_decided_by THEN
    RETURN QUERY SELECT 'self_target'::TEXT, v.version, v.subject_id;
    RETURN;
  END IF;

  UPDATE core.email_change_requests
  SET state = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      decided_by_subject_id = p_decided_by, decided_at = now(), decision_reason = p_reason,
      version = version + 1
  WHERE id = v.id;

  IF p_approve THEN
    PERFORM core.issue_email_challenge(
      p_challenge_id, 'email_change', v.new_email, v.tenant_id, v.subject_id, NULL, v.id,
      p_code_hmac, 'email_change_code', v.new_email, p_code
    );
  END IF;
  RETURN QUERY SELECT CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, v.version + 1, v.subject_id;
END
$$;

/**
 * Completes an approved email change with the code sent to the new address: swaps the address,
 * ends every session of the subject (`core.revoke_subject_sessions`, reason `email_changed`),
 * stops the old address's unanswered codes and tells the old address what happened.
 *
 * Status: `completed`, `rate_limited`, `code_invalid`, `code_expired`, `attempts_exhausted`,
 * `email_unavailable` (the new address was taken in the meantime; the request is expired).
 * `previous_email` comes back only so the API can audit a keyed hash of it.
 */
CREATE FUNCTION core.complete_email_change(
  p_new_email TEXT, p_code_hmac BYTEA, p_email_key TEXT, p_ip_key TEXT
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID,
  email_change_id UUID, previous_email TEXT, revoked_sessions INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_email TEXT := core.normalize_email(p_new_email);
  r RECORD;
  v core.email_change_requests%ROWTYPE;
  v_previous TEXT;
  v_revoked INTEGER;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry = 0 THEN
    v_retry := core.take_auth_rate('code_verify', 'email:' || p_email_key, 10, interval '15 minutes');
  END IF;
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT * INTO r FROM core.consume_email_challenge('email_change', v_email, NULL, p_code_hmac);
  IF r.status <> 'ok' THEN
    RETURN QUERY SELECT r.status, 0, r.tenant_id, r.subject_id, r.email_change_id, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT * INTO v FROM core.email_change_requests c
  WHERE c.id = r.email_change_id AND c.state = 'approved' AND c.decided_at > now() - interval '72 hours'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0, r.tenant_id, r.subject_id, r.email_change_id, NULL::TEXT, 0;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v_email) THEN
    UPDATE core.email_change_requests SET state = 'expired', version = version + 1 WHERE id = v.id;
    RETURN QUERY SELECT 'email_unavailable'::TEXT, 0, v.tenant_id, v.subject_id, v.id, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT s.email INTO v_previous FROM core.subjects s WHERE s.id = v.subject_id FOR UPDATE;
  UPDATE core.subjects SET email = v_email, version = version + 1 WHERE id = v.subject_id;
  UPDATE core.email_change_requests
  SET state = 'completed', completed_at = now(), version = version + 1
  WHERE id = v.id;

  IF v_previous IS NOT NULL THEN
    PERFORM core.supersede_email_challenge('sign_in', v_previous);
    INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
    VALUES (
      gen_random_uuid(), 'email_changed_notice', v_previous, '{}'::jsonb, 'pending',
      now() + interval '1 day'
    );
  END IF;

  -- `revoke_subject_sessions` ends only sessions of the current tenant; set it for this call.
  PERFORM set_config('app.current_tenant', v.tenant_id::TEXT, true);
  v_revoked := core.revoke_subject_sessions(v.subject_id, 'email_changed');

  RETURN QUERY SELECT 'completed'::TEXT, 0, v.tenant_id, v.subject_id, v.id, v_previous, v_revoked;
END
$$;

-- ---------------------------------------------------------------------------
-- Purge
-- ---------------------------------------------------------------------------

/**
 * Deletes what no flow can use any more: rate events past every window, settled mail, mail past
 * its expiry (marked first, so its secret goes too), challenges a day old that no session names,
 * and test-sink rows. Takes no time argument, like `core.purge_auth_records` (0108).
 */
CREATE FUNCTION core.purge_email_auth_records()
RETURNS TABLE (purged_challenges INTEGER, purged_mail INTEGER, purged_rate_events INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_challenges INTEGER;
  v_mail INTEGER;
  v_rate INTEGER;
BEGIN
  UPDATE core.email_outbox
  SET state = 'expired', recipient = NULL, params = NULL, settled_at = now()
  WHERE state = 'pending' AND expires_at <= now();

  DELETE FROM core.email_outbox WHERE state <> 'pending' AND settled_at <= now() - interval '1 day';
  GET DIAGNOSTICS v_mail = ROW_COUNT;

  DELETE FROM core.email_challenges c
  WHERE c.created_at <= now() - interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM core.sessions s WHERE s.email_challenge_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM core.email_outbox o WHERE o.challenge_id = c.id);
  GET DIAGNOSTICS v_challenges = ROW_COUNT;

  DELETE FROM core.auth_rate_events WHERE occurred_at <= now() - interval '1 day';
  GET DIAGNOSTICS v_rate = ROW_COUNT;

  DELETE FROM core.email_test_sink WHERE recorded_at <= now() - interval '1 day';

  RETURN QUERY SELECT v_challenges, v_mail, v_rate;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION core.start_email_challenge(
  core.email_challenge_purpose, TEXT, TEXT, UUID, BYTEA, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.verify_sign_in_code(TEXT, BYTEA, TEXT, TEXT, UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.create_invitation(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.revoke_invitation(UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.accept_invitation(TEXT, BYTEA, TEXT, UUID, TEXT, UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.request_email_change(UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.decide_email_change(UUID, UUID, BOOLEAN, TEXT, INTEGER, UUID, BYTEA, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.complete_email_change(TEXT, BYTEA, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.purge_email_auth_records() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.start_email_challenge(
  core.email_challenge_purpose, TEXT, TEXT, UUID, BYTEA, TEXT, TEXT, TEXT
) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.verify_sign_in_code(TEXT, BYTEA, TEXT, TEXT, UUID, TEXT, INTEGER) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.create_invitation(UUID, UUID, TEXT, UUID, TEXT, TEXT) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.revoke_invitation(UUID, UUID, INTEGER) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.accept_invitation(TEXT, BYTEA, TEXT, UUID, TEXT, UUID, TEXT, INTEGER) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.request_email_change(UUID, UUID, TEXT, TEXT, UUID) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.decide_email_change(UUID, UUID, BOOLEAN, TEXT, INTEGER, UUID, BYTEA, TEXT) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.complete_email_change(TEXT, BYTEA, TEXT, TEXT) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.purge_email_auth_records() TO mpc_worker;
