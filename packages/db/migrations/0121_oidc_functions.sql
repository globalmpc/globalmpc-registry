-- Google and Microsoft sign-in, linking and unlinking — account authentication WP4.
--
-- **The database decides, the API only verifies the token.** The API runs the authorization-code
-- flow (PKCE S256, `state`, `nonce`) with `openid-client` and checks the ID token's signature,
-- issuer, audience, expiry, nonce and `azp`; the database cannot. Everything else is decided
-- here, inside one transaction per step, as for the emailed code (0114) and the second factors
-- (0116):
--
-- | Step | Function | Decides |
-- | --- | --- | --- |
-- | Start | `core.start_oidc_transaction` | Per-IP limit; a link only from a live aal2+ account session that is not recovery-limited, in the caller's tenant; an invitation only while it is pending |
-- | Callback | `core.claim_oidc_transaction` | The `state` exists, was not claimed, has not expired, is for this provider, carries this browser's binding and — for a link — comes back on the session that started it. Claiming clears the sealed verifier: one callback per state |
-- | Sign-in | `core.complete_oidc_sign_in` | The identity is found by `(provider, issuer, subject_key)` only. None → `not_found`: no account is created and nothing is matched by email |
-- | Link | `core.complete_oidc_link` | The session is still live and aal2+; the identity is linked nowhere (any tenant) → linked to this subject; otherwise one generic `unavailable` |
-- | Invitation | `core.complete_oidc_invitation` | The address the provider verified is the invited one; the identity is linked nowhere; the address is taken nowhere — then subject, identity, accepted invitation and session in one transaction |
-- | Unlink | `core.unlink_external_identity` | aal2+, not recovery-limited, the identity is this subject's, it is not the last sign-in method; the sessions it signed in end |
--
-- **Outcomes are returned, not raised**, and a completion that refuses still marks the
-- transaction completed: a refused callback must not leave its state usable for a second try.
--
-- `core.create_subject_session` now refuses `google` and `microsoft` too, so no first factor can
-- be stated by a caller any more; every account session comes from a function that consumed
-- its evidence.

-- ---------------------------------------------------------------------------
-- The general session function refuses every first factor it could only take on trust
-- ---------------------------------------------------------------------------

/**
 * 0116's body (same signature) with one more refusal: `google` and `microsoft` sessions are
 * created only by the functions below, which complete a login transaction in the same
 * transaction (0120's CHECK and trigger hold that at the table as well). Every first factor is
 * now refused here; the function stays only so the grant history and older callers fail loudly
 * rather than with "does not exist". The application role loses its grant.
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
$$;

REVOKE EXECUTE ON FUNCTION core.create_subject_session(
  UUID, TEXT, UUID, core.session_first_factor, core.session_second_factor, INTEGER
) FROM mpc_app;

-- ---------------------------------------------------------------------------
-- Building blocks (granted to nobody)
-- ---------------------------------------------------------------------------

/** Serialises everything that decides who holds an identity key: link, invitation. */
CREATE FUNCTION core.lock_external_identity(p_provider core.oidc_provider, p_issuer TEXT, p_subject_key TEXT)
RETURNS VOID
LANGUAGE sql
VOLATILE
SET search_path = core, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('mpc-oidc-identity:' || p_provider || ':' || p_issuer || ':' || p_subject_key, 0))
$$;

/** Locks a claimed, uncompleted transaction of `p_purpose`. NULL row when there is none. */
CREATE FUNCTION core.oidc_lock_claimed(p_transaction_id UUID, p_purpose core.oidc_purpose)
RETURNS core.oidc_login_transactions
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.oidc_login_transactions;
BEGIN
  SELECT * INTO v FROM core.oidc_login_transactions t
  WHERE t.id = p_transaction_id AND t.purpose = p_purpose
    AND t.claimed_at IS NOT NULL AND t.completed_at IS NULL
    -- The code exchange between claim and completion is bounded by the API's provider timeout;
    -- a claim left far behind is not completed.
    AND t.claimed_at > now() - interval '5 minutes'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OIDC_TRANSACTION_INVALID: no claimed % transaction %', p_purpose, p_transaction_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v;
END
$$;

/** Marks a transaction completed with `p_outcome`, in this database transaction. */
CREATE FUNCTION core.oidc_complete(
  p_transaction_id UUID, p_outcome TEXT, p_tenant UUID, p_subject UUID, p_identity UUID
) RETURNS VOID
LANGUAGE sql
VOLATILE
SET search_path = core, pg_temp
AS $$
  UPDATE core.oidc_login_transactions
  SET completed_at = now(), completed_txid = pg_current_xact_id(), outcome = p_outcome,
      tenant_id = COALESCE(p_tenant, tenant_id), subject_id = COALESCE(p_subject, subject_id),
      identity_id = COALESCE(p_identity, identity_id)
  WHERE id = p_transaction_id
$$;

/** Inserts the session a completed transaction proves. The 0120 trigger re-checks the binding. */
CREATE FUNCTION core.insert_oidc_session(
  p_transaction_id UUID, p_provider core.oidc_provider, p_subject_id UUID, p_tenant_id UUID,
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
    id, token_hash, tenant_id, subject_id, first_factor, oidc_transaction_id, expires_at
  ) VALUES (
    p_session_id, p_token_hash, p_tenant_id, p_subject_id,
    p_provider::text::core.session_first_factor, p_transaction_id,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$$;

REVOKE EXECUTE ON FUNCTION core.lock_external_identity(core.oidc_provider, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.oidc_lock_claimed(UUID, core.oidc_purpose) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.oidc_complete(UUID, TEXT, UUID, UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.insert_oidc_session(UUID, core.oidc_provider, UUID, UUID, UUID, TEXT, INTEGER) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Start
-- ---------------------------------------------------------------------------

/**
 * Records a login transaction the API is about to send the browser off with.
 *
 * - `sign_in`: no session, no invitation, no tenant.
 * - `link`: `p_session_id` is the caller's session. It must be a live account session in the
 *   caller's tenant context, past a second factor (aal2+) and not limited by a recovery code —
 *   a first-factor session must not add a way in (plan §3: linked "from a session that already
 *   passed MFA"). The session and its subject are recorded; the callback must come back on it.
 * - `invitation_accept`: the invitation is found by its token hash and must be pending.
 *
 * Status: `started`, `rate_limited` (30 per 15 minutes per requester IP), `session_invalid`,
 * `step_up_required`, `invitation_invalid`.
 */
CREATE FUNCTION core.start_oidc_transaction(
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
    IF v_session.recovery_limited OR core.mfa_session_rank(v_session) < 2 THEN
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

-- ---------------------------------------------------------------------------
-- Callback
-- ---------------------------------------------------------------------------

/**
 * Claims the transaction a callback's `state` names, once, and hands back what the code
 * exchange needs (the sealed verifier and nonce, the nonce hash, the redirect URI).
 *
 * Refused (`state_invalid`, nothing changes): unknown state, already claimed (a replay), another
 * provider, another browser (binding), a link transaction outside the session that started it,
 * or a sign-in / invitation transaction on a session-bound callback. Refused and spent
 * (`state_expired`): past its 10 minutes. The binding is compared in constant time.
 */
CREATE FUNCTION core.claim_oidc_transaction(
  p_state_hash TEXT, p_binding_hash TEXT, p_provider core.oidc_provider, p_session_id UUID
) RETURNS TABLE (
  status TEXT, transaction_id UUID, purpose core.oidc_purpose, secret BYTEA, nonce_hash TEXT,
  redirect_uri TEXT, tenant_id UUID, invitation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
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
      NULL::TEXT, NULL::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  UPDATE core.oidc_login_transactions SET claimed_at = now(), secret_ciphertext = NULL WHERE id = v.id;

  IF v.expires_at <= now() THEN
    RETURN QUERY SELECT 'state_expired'::TEXT, v.id, v.purpose, NULL::BYTEA, NULL::TEXT, NULL::TEXT,
      v.tenant_id, v.invitation_id;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'claimed'::TEXT, v.id, v.purpose, v.secret_ciphertext, v.nonce_hash,
    v.redirect_uri, v.tenant_id, v.invitation_id;
END
$$;

-- ---------------------------------------------------------------------------
-- Completion
-- ---------------------------------------------------------------------------

/**
 * Signs in with a verified ID token: finds the identity **only** by `(provider, issuer,
 * subject_key)` and creates an aal1 session for its subject, in its tenant.
 *
 * Status `session_created`, or `not_found` — no live identity has that key. The email in the
 * token never reaches this function, so no address can match an account (plan §5, nOAuth).
 */
CREATE FUNCTION core.complete_oidc_sign_in(
  p_transaction_id UUID,
  p_issuer TEXT,
  p_subject_key TEXT,
  p_session_id UUID,
  p_token_hash TEXT,
  p_ttl_seconds INTEGER
) RETURNS TABLE (
  status TEXT, tenant_id UUID, subject_id UUID, identity_id UUID, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'sign_in');
  v_identity core.external_identities;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_identity FROM core.external_identities i
  WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
    AND i.revoked_at IS NULL;
  IF NOT FOUND THEN
    PERFORM core.oidc_complete(v.id, 'not_found', NULL, NULL, NULL);
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  UPDATE core.external_identities SET last_used_at = now() WHERE id = v_identity.id;
  PERFORM core.oidc_complete(v.id, 'session', v_identity.tenant_id, v_identity.subject_id, v_identity.id);
  v_expires := core.insert_oidc_session(
    v.id, v.provider, v_identity.subject_id, v_identity.tenant_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT, v_identity.tenant_id, v_identity.subject_id, v_identity.id, v_expires;
END
$$;

/**
 * Links a verified identity to the subject of the session that started the transaction.
 *
 * The session must still be live, in the caller's tenant context, aal2+ and not
 * recovery-limited — the same rule as at the start, checked again with the subject and session
 * locked (0118's order), because the session may have ended or been reset in between.
 *
 * Status `linked`, `unavailable` (the identity is live on any subject, this one included, in any
 * tenant — one answer, so the caller learns nothing about where), `provider_already_linked` (this
 * person already has a live identity of this provider), `step_up_required`.
 */
CREATE FUNCTION core.complete_oidc_link(
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
  IF v_session.recovery_limited OR core.mfa_session_rank(v_session) < 2 THEN
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

/**
 * Accepts an invitation with a verified ID token instead of an emailed code (plan journey 1).
 *
 * `p_verified_email` is the address the provider **verified** for this token (the API passes
 * NULL when it did not), normalised. It must be the invited address: the invitation names an
 * address and the provider vouches that the person controls it, which is what the code would
 * have shown. Then, in this transaction, exactly what 0114's acceptance does — a person in the
 * invitation's tenant and organisation with the lowest identity assurance and **no role**, the
 * invitation accepted, its unused codes and unsent mail dropped — plus the identity linked and
 * an aal1 session. The first-enrolment window (24 h) runs from the subject's creation, as for a
 * code acceptance.
 *
 * Status `session_created`, `invitation_invalid` (no longer pending), `email_mismatch` (no
 * verified address, or another one), `identity_unavailable` (the identity is live somewhere),
 * `email_unavailable` (the address was taken after the invitation was made; the invitation is
 * expired by the system, as in 0114).
 */
CREATE FUNCTION core.complete_oidc_invitation(
  p_transaction_id UUID,
  p_issuer TEXT,
  p_subject_key TEXT,
  p_idp_tenant TEXT,
  p_verified_email TEXT,
  p_email_hash TEXT,
  p_identity_id UUID,
  p_subject_id UUID,
  p_session_id UUID,
  p_token_hash TEXT,
  p_ttl_seconds INTEGER
) RETURNS TABLE (
  status TEXT, tenant_id UUID, subject_id UUID, organization_id UUID, invitation_id UUID,
  identity_id UUID, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
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
    PERFORM core.oidc_complete(v.id, 'invitation_invalid', NULL, NULL, NULL);
    RETURN QUERY SELECT 'invitation_invalid'::TEXT, v.tenant_id, NULL::UUID, NULL::UUID, v.invitation_id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_verified_email IS NULL OR core.normalize_email(p_verified_email) <> v_invitation.email THEN
    PERFORM core.oidc_complete(v.id, 'email_mismatch', NULL, NULL, NULL);
    RETURN QUERY SELECT 'email_mismatch'::TEXT, v_invitation.tenant_id, NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_external_identity(v.provider, p_issuer, p_subject_key);
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
      AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL, NULL);
    RETURN QUERY SELECT 'identity_unavailable'::TEXT, v_invitation.tenant_id, NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_invitation.email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v_invitation.email) THEN
    UPDATE core.invitations SET state = 'expired', version = version + 1 WHERE id = v_invitation.id;
    PERFORM core.oidc_complete(v.id, 'email_unavailable', NULL, NULL, NULL);
    RETURN QUERY SELECT 'email_unavailable'::TEXT, v_invitation.tenant_id, NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level, email, organization_id)
  VALUES (p_subject_id, v_invitation.tenant_id, 'person', v.display_name, 'wallet_only',
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
    id, tenant_id, subject_id, provider, issuer, subject_key, idp_tenant, email_hash, linked_via, last_used_at
  ) VALUES (
    p_identity_id, v_invitation.tenant_id, p_subject_id, v.provider, p_issuer, p_subject_key,
    p_idp_tenant, p_email_hash, 'invitation', now()
  );
  PERFORM core.oidc_complete(v.id, 'session', v_invitation.tenant_id, p_subject_id, p_identity_id);
  v_expires := core.insert_oidc_session(
    v.id, v.provider, p_subject_id, v_invitation.tenant_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT, v_invitation.tenant_id, p_subject_id,
    v_invitation.organization_id, v_invitation.id, p_identity_id, v_expires;
END
$$;

-- ---------------------------------------------------------------------------
-- The holder's identities
-- ---------------------------------------------------------------------------

/** The live and unlinked identities of the session's subject, for the settings screen. */
CREATE FUNCTION core.list_external_identities(p_session_id UUID)
RETURNS TABLE (
  id UUID, provider core.oidc_provider, issuer TEXT, idp_tenant TEXT, linked_via TEXT,
  created_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT i.id, i.provider, i.issuer, i.idp_tenant, i.linked_via, i.created_at, i.last_used_at, i.revoked_at
  FROM core.sessions s
  JOIN core.external_identities i ON i.subject_id = s.subject_id AND i.tenant_id = s.tenant_id
  WHERE s.id = p_session_id AND s.tenant_id = core.current_tenant()
    AND s.revoked_at IS NULL AND s.expires_at > now()
  ORDER BY i.created_at DESC
  LIMIT 50
$$;

/**
 * Unlinks one of the session subject's identities and ends the sessions it signed in.
 *
 * Needs aal2+ and no recovery limit (as removing a factor, 0116: a first-factor session must not
 * change how the account is reached). Never removes the last way to sign in: the account's
 * address counts as one, so only a person without an address (a legacy wallet-only subject that
 * somehow holds an identity) can hit `OIDC_LAST_SIGN_IN_METHOD`. Raises the refusal codes; the
 * API maps them. Returns how many sessions ended and whether this one did.
 */
CREATE FUNCTION core.unlink_external_identity(p_session_id UUID, p_identity_id UUID)
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
  IF core.mfa_session_rank(v) < 2 THEN
    RAISE EXCEPTION 'MFA_STEP_UP_REQUIRED: unlinking needs a session at aal2'
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

-- ---------------------------------------------------------------------------
-- Purge
-- ---------------------------------------------------------------------------

/**
 * Deletes login transactions a day old that no session names. The audit trail keeps who signed
 * in and what was linked; an old transaction holds only hashes and, once claimed, no secret.
 * Takes no time argument, like `core.purge_auth_records` (0108).
 */
CREATE FUNCTION core.purge_oidc_records() RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM core.oidc_login_transactions t
  WHERE t.created_at <= now() - interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM core.sessions s WHERE s.oidc_transaction_id = t.id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  core.start_oidc_transaction(UUID, core.oidc_provider, core.oidc_purpose, TEXT, TEXT, TEXT, BYTEA, TEXT, UUID, TEXT, TEXT, TEXT),
  core.claim_oidc_transaction(TEXT, TEXT, core.oidc_provider, UUID),
  core.complete_oidc_sign_in(UUID, TEXT, TEXT, UUID, TEXT, INTEGER),
  core.complete_oidc_link(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID),
  core.complete_oidc_invitation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, TEXT, INTEGER),
  core.list_external_identities(UUID),
  core.unlink_external_identity(UUID, UUID),
  core.purge_oidc_records()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  core.start_oidc_transaction(UUID, core.oidc_provider, core.oidc_purpose, TEXT, TEXT, TEXT, BYTEA, TEXT, UUID, TEXT, TEXT, TEXT),
  core.claim_oidc_transaction(TEXT, TEXT, core.oidc_provider, UUID),
  core.complete_oidc_sign_in(UUID, TEXT, TEXT, UUID, TEXT, INTEGER),
  core.complete_oidc_link(UUID, UUID, TEXT, TEXT, TEXT, TEXT, UUID),
  core.complete_oidc_invitation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, TEXT, INTEGER),
  core.list_external_identities(UUID),
  core.unlink_external_identity(UUID, UUID)
TO mpc_app;

GRANT EXECUTE ON FUNCTION core.purge_oidc_records() TO mpc_worker;
