-- Final cross-package review of the account state machine (0112–0131): five fixes.
--
-- F1. **A Google / Microsoft sign-in does not outlive a revocation of its identity.**
--     `core.complete_oidc_sign_in` read the identity without a lock and then updated it by id. A
--     sign-in racing an approved MFA reset, a completed address change or an unlink waited for
--     the revocation to commit and then still created its session — after the revocation had
--     ended the person's sessions — and that session could enrol in the reset's window: the
--     takeover 0123 (M3) closed. The identity is now found and locked by one UPDATE that requires
--     `revoked_at IS NULL`; under READ COMMITTED it waits for the revoking transaction and
--     re-checks the committed row. As a second line, `core.resolve_session` refuses a Google /
--     Microsoft session whose identity (recorded on its login transaction, 0120) is revoked.
--
--     The other two completions need no change. `core.complete_oidc_link` takes the subject lock
--     first (`core.mfa_lock_session`), as every revoking function now does (F3): a revocation that
--     holds it makes the link find its session revoked; a link that holds it is committed before
--     the revocation reads the identities, which then revokes the new one too.
--     `core.complete_oidc_invitation` creates a new person, whom no recovery can target yet; it
--     locks the invitation `FOR UPDATE` with `state = 'pending'`, so a revocation or a closure
--     (F2) that commits first makes it `invitation_invalid`.
--
-- F2. **A suspended admin's approvals stop working.** 0128 closed what the suspended person
--     proposed. What they approved and has not taken effect yet now closes too: an approved email
--     change still waiting for its code (`expired`, `approver_suspended`, its code superseded), an
--     approved reset whose window is open (`closed_reason = 'approver_suspended'`; the decision
--     stays as made, the window stops counting) and a pending invitation they created (`expired`,
--     `inviter_suspended`, its code and mail dropped). Each is in `closed_requests`, which the API
--     audits one row each. People suspended before this migration are swept once, audited as the
--     migration. A suspended person can no longer create an invitation (0128's actor trigger).
--
-- F3. **One lock order: the person, then their requests.** `core.decide_mfa_reset`,
--     `core.decide_email_change` and `core.decide_subject_suspension` locked the request row
--     before the subject row; `core.complete_email_change` locked the challenge and the request
--     before it. A suspension (subject, then the person's requests and challenges) and any of them
--     on the same person could deadlock (40P01). Each now reads the request's subject unlocked,
--     locks the subject, and only then locks the request (and, for the completion, consumes the
--     code). A suspension also closes rows of other people (F2, and 0128's proposals); it takes
--     those row locks after its own subject lock and never a second subject lock, and nothing
--     holding such a row waits for the suspended person's subject.
--
-- F4. (In `0130`, which consolidates once: see its header.)
--
-- F5. **The actor and reset guards refuse when they read nothing.** `core.refuse_suspended_actor`
--     and `core.mfa_reset_separation_guard` answered "not suspended" when the subject could not be
--     read — under an owner filtered by RLS, an open door. Both now raise when the row is not
--     found. They run inside the caller's tenant (the app's own writes) or inside a function that
--     already has `row_security = off`, so they stay same-tenant (0131's list); failing closed on
--     a missing row does not depend on how the owner is configured, which `row_security = off`
--     alone would.
--
-- Decision table (docs/review-guidelines.md):
--
-- | Event | Identity namespace | Authority | Frozen | Live | Input scope | Priority |
-- | --- | --- | --- | --- | --- | --- | --- |
-- | OIDC sign-in | (provider, issuer, subject key), any tenant | the provider's verified token | revoked identities, ended sessions | the identity, re-read under its row lock | one claimed transaction | revoked identity > suspension > session |
-- | Session resolution | token hash, then the session's login transaction | the database | — | session, factor proofs, identity | one session | revoked / suspended > idle > live |
-- | Suspension approved | the person, its tenant | two admins outside the separation | decided and completed requests, audit, consumed codes | open requests the person proposed or approved, pending invitations they created | the person and what names them as proposer, approver or inviter | suspension before anything still open |
-- | Recovery / email change decisions | the person, its tenant | two admins | — | subject row first, then the request | one request | whichever locks the person first; the other re-reads |
--
-- `closed_reason` stays writable only by definer functions (0128's grants; invitations have no
-- application write at all).

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- F2. Closed shapes for what a suspended approver leaves behind
-- ---------------------------------------------------------------------------

ALTER TABLE core.email_change_requests DROP CONSTRAINT email_change_closed_shape;
ALTER TABLE core.email_change_requests ADD CONSTRAINT email_change_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason IN ('subject_suspended', 'proposer_suspended') AND state = 'expired')
  OR (closed_reason = 'approver_suspended' AND state = 'expired' AND decided_by_subject_id IS NOT NULL)
);

-- An approved reset keeps its decision as made (decider, time, the window it opened); the closure
-- is recorded next to it and `core.mfa_reset_window_open` stops counting it.
ALTER TABLE core.mfa_reset_requests DROP CONSTRAINT mfa_reset_closed_shape;
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason IN ('subject_suspended', 'proposer_suspended') AND state = 'rejected'
    AND decided_by_subject_id IS NULL AND decided_at IS NOT NULL AND enrolment_window_until IS NULL)
  OR (closed_reason = 'approver_suspended' AND state = 'approved' AND origin = 'admin'
    AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND enrolment_window_until = decided_at + interval '24 hours')
);

-- Invitations get the same column. The application role cannot write invitations at all (0113:
-- SELECT only), so only the definer functions set it.
ALTER TABLE core.invitations ADD COLUMN closed_reason TEXT;
ALTER TABLE core.invitations ADD CONSTRAINT invitations_closed_shape CHECK (
  closed_reason IS NULL OR (closed_reason = 'inviter_suspended' AND state = 'expired')
);

-- No suspended person invites anyone, and no row is inserted already closed (0128's trigger).
CREATE TRIGGER invitations_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.invitations
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('invited_by_subject_id', 'revoked_by_subject_id');

-- People suspended before this migration: close now what they approved or created and what is
-- still open, as the decision below does from now on. Audited as the migration (no actor).
DO $$
DECLARE
  lift BOOLEAN := NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
  r RECORD;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  IF lift THEN
    ALTER TABLE core.subjects NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.email_change_requests NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.email_challenges NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.mfa_reset_requests NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.invitations NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit.events NO FORCE ROW LEVEL SECURITY;
  END IF;

  FOR r IN
    WITH suspended AS (SELECT id FROM core.subjects WHERE suspended_at IS NOT NULL),
    closed_changes AS (
      UPDATE core.email_change_requests c
      SET state = 'expired', closed_reason = 'approver_suspended', version = c.version + 1
      WHERE c.decided_by_subject_id IN (SELECT id FROM suspended) AND c.state = 'approved'
      RETURNING c.tenant_id, c.id, c.decided_by_subject_id AS actor, c.version, c.new_email,
        'email_change_request'::TEXT AS kind, 'approver_suspended'::TEXT AS reason
    ),
    closed_resets AS (
      UPDATE core.mfa_reset_requests m
      SET closed_reason = 'approver_suspended', version = m.version + 1
      WHERE m.decided_by_subject_id IN (SELECT id FROM suspended) AND m.state = 'approved'
        AND m.closed_reason IS NULL AND m.enrolment_window_until > now()
      RETURNING m.tenant_id, m.id, m.decided_by_subject_id AS actor, m.version, NULL::TEXT AS new_email,
        'mfa_reset_request'::TEXT AS kind, 'approver_suspended'::TEXT AS reason
    ),
    closed_invitations AS (
      UPDATE core.invitations i
      SET state = 'expired', closed_reason = 'inviter_suspended', version = i.version + 1
      WHERE i.invited_by_subject_id IN (SELECT id FROM suspended) AND i.state = 'pending'
      RETURNING i.tenant_id, i.id, i.invited_by_subject_id AS actor, i.version, NULL::TEXT AS new_email,
        'invitation'::TEXT AS kind, 'inviter_suspended'::TEXT AS reason
    )
    SELECT * FROM closed_changes UNION ALL SELECT * FROM closed_resets UNION ALL SELECT * FROM closed_invitations
  LOOP
    IF r.kind = 'email_change_request' THEN
      PERFORM core.supersede_email_challenge('email_change', r.new_email);
    ELSIF r.kind = 'invitation' THEN
      UPDATE core.email_challenges SET superseded_at = now()
      WHERE invitation_id = r.id AND consumed_at IS NULL AND superseded_at IS NULL;
      UPDATE core.email_outbox
      SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
      WHERE invitation_id = r.id AND state = 'pending';
    END IF;
    INSERT INTO audit.events (
      tenant_id, actor_subject_id, actor_wallet, effective_role, command, resource_type, resource_id,
      before_version, after_version, reason, correlation_id, detail
    ) VALUES (
      r.tenant_id, NULL, NULL, NULL, 'migration.subject_suspension.request_closed', r.kind, r.id,
      r.version - 1, r.version, r.reason, 'migration-0132',
      jsonb_build_object('suspendedSubjectId', r.actor, 'reason', r.reason)
    );
  END LOOP;

  IF lift THEN
    ALTER TABLE core.subjects FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.email_change_requests FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.email_challenges FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.mfa_reset_requests FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.invitations FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;
  END IF;
  PERFORM set_config('row_security', 'on', true);
END
$$;

-- ---------------------------------------------------------------------------
-- F1. Google / Microsoft sign-in does not outlive a revocation of its identity
-- ---------------------------------------------------------------------------

/** 0127's completion; the identity is found and locked by one UPDATE (F1). */
CREATE OR REPLACE FUNCTION core.complete_oidc_sign_in(
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
SET row_security = off
AS $$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'sign_in');
  v_identity core.external_identities;
  v_expires TIMESTAMPTZ;
BEGIN
  -- 0132 (F1): found and locked in one statement. Whatever revokes the identity (an MFA reset, an
  -- address change, an unlink, a suspension) holds its row until it commits; this UPDATE waits for
  -- it and, under READ COMMITTED, re-checks `revoked_at` on the committed row. A revoked identity
  -- therefore signs nobody in, however the two interleave. When this one locks first, the
  -- revocation waits for it and then ends the session it created (`revoke_subject_sessions` reads
  -- after the identity lock is released).
  UPDATE core.external_identities i SET last_used_at = now()
  WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
    AND i.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM core.subjects s WHERE s.id = i.subject_id AND s.suspended_at IS NOT NULL
    )
  RETURNING i.* INTO v_identity;
  IF v_identity.id IS NULL THEN
    PERFORM core.oidc_complete(v.id, 'not_found', NULL, NULL, NULL);
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.oidc_complete(v.id, 'session', v_identity.tenant_id, v_identity.subject_id, v_identity.id);
  v_expires := core.insert_oidc_session(
    v.id, v.provider, v_identity.subject_id, v_identity.tenant_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT, v_identity.tenant_id, v_identity.subject_id, v_identity.id, v_expires;
END
$$;

/** 0127's resolver, plus: an OIDC session whose identity is revoked does not resolve (F1). */
CREATE OR REPLACE FUNCTION core.resolve_session(p_token_hash TEXT)
RETURNS TABLE (
  session_id       UUID,
  subject_id       UUID,
  tenant_id        UUID,
  first_factor     core.session_first_factor,
  second_factor    core.session_second_factor,
  second_factor_at TIMESTAMPTZ,
  recovery_limited BOOLEAN,
  assurance_level  core.assurance_level,
  expires_at       TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
SET row_security = off
AS $$
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
    -- 0132 (F1): a Google / Microsoft session stands on the identity its transaction completed
    -- with; once that identity is revoked (or gone), the session does not resolve.
    AND (s.oidc_transaction_id IS NULL OR EXISTS (
      SELECT 1
      FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = s.oidc_transaction_id AND i.revoked_at IS NULL
    ))
  RETURNING
    s.id, s.subject_id, s.tenant_id, s.first_factor, s.second_factor, s.second_factor_at,
    s.recovery_limited,
    (SELECT subject.assurance_level FROM core.subjects subject WHERE subject.id = s.subject_id),
    s.expires_at
$$;

-- ---------------------------------------------------------------------------
-- F3. The person first, then the request
-- ---------------------------------------------------------------------------

/** 0129's decision; the subject is locked before the request (F3). */
CREATE OR REPLACE FUNCTION core.decide_mfa_reset(
  p_request_id UUID,
  p_decider UUID,
  p_approve BOOLEAN,
  p_reason TEXT,
  p_expected_version INTEGER
) RETURNS TABLE (
  revoked_sessions       INTEGER,
  revoked_authenticators INTEGER,
  voided_recovery_codes  INTEGER,
  new_version            INTEGER,
  released_elevations    JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_request core.mfa_reset_requests;
  v_sessions INTEGER := 0;
  v_authenticators INTEGER := 0;
  v_count INTEGER;
  v_codes INTEGER := 0;
  v_removed TEXT[] := ARRAY[]::TEXT[];
  v_suspended TIMESTAMPTZ;
  v_released JSONB := '[]'::jsonb;
  v_subject_id UUID;
BEGIN
  -- 0132 (F3): the person's subject row first, then the request (see the header). The request's
  -- subject never changes, so reading it unlocked is enough to know which row to lock.
  SELECT r.subject_id INTO v_subject_id FROM core.mfa_reset_requests r
  WHERE r.id = p_request_id AND r.tenant_id = core.current_tenant();
  IF FOUND THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;
  SELECT * INTO v_request FROM core.mfa_reset_requests
  WHERE id = p_request_id AND tenant_id = core.current_tenant()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_RESET_NOT_FOUND: no such reset request' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_request.version <> p_expected_version THEN
    RAISE EXCEPTION 'MFA_RESET_VERSION_MISMATCH: current version is %', v_request.version
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_request.state <> 'pending' THEN
    RAISE EXCEPTION 'MFA_RESET_ALREADY_DECIDED: the request is %', v_request.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_decider = v_request.requested_by_subject_id THEN
    RAISE EXCEPTION 'MFA_RESET_SELF_APPROVAL: the proposer cannot decide' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decider = v_request.subject_id THEN
    RAISE EXCEPTION 'MFA_RESET_SELF_TARGET: the person reset cannot decide' USING ERRCODE = 'check_violation';
  END IF;

  IF p_approve THEN
    SELECT suspended_at INTO v_suspended FROM core.subjects WHERE id = v_request.subject_id FOR UPDATE;
    IF v_suspended IS NOT NULL THEN
      RAISE EXCEPTION 'MFA_RESET_SUBJECT_SUSPENDED: the person is suspended' USING ERRCODE = 'check_violation';
    END IF;
    IF core.recovery_separation_conflict(v_request.subject_id, p_decider, 'mfa_reset')
       OR core.recovery_separation_conflict(v_request.subject_id, v_request.requested_by_subject_id, 'mfa_reset') THEN
      RAISE EXCEPTION 'MFA_RESET_SEPARATION_REQUIRED: the proposer or decider took part in a recent email change or suspension of this person'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE core.mfa_reset_requests
  SET state = CASE WHEN p_approve THEN 'approved'::core.mfa_reset_state ELSE 'rejected' END,
      decided_by_subject_id = p_decider,
      decided_at = now(),
      decision_reason = p_reason,
      enrolment_window_until = CASE WHEN p_approve THEN now() + interval '24 hours' END,
      version = version + 1
  WHERE id = v_request.id;

  IF p_approve THEN
    UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'mfa_reset'
    WHERE subject_id = v_request.subject_id AND tenant_id = v_request.tenant_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_count;

    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'mfa_reset'
    WHERE subject_id = v_request.subject_id AND tenant_id = v_request.tenant_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_authenticators + v_count;

    UPDATE core.recovery_codes SET voided_at = now()
    WHERE subject_id = v_request.subject_id AND tenant_id = v_request.tenant_id
      AND consumed_at IS NULL AND voided_at IS NULL;
    GET DIAGNOSTICS v_codes = ROW_COUNT;

    v_removed := core.revoke_subject_identities(v_request.subject_id, v_request.tenant_id, 'mfa_reset');

    -- 0129: an approved elevation ends with the factors it was approved over. The person enrols
    -- new ones in the reset's window; break-glass needs a new approval.
    v_released := core.end_subject_elevations(v_request.subject_id, v_request.tenant_id, p_decider, 'mfa_reset');

    v_sessions := core.revoke_subject_sessions(v_request.subject_id, 'mfa_reset');

    INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
    SELECT gen_random_uuid(), 'mfa_reset_notice', a.address,
           jsonb_build_object('removedSignIns', to_jsonb(v_removed)), 'pending', now() + interval '1 day'
    FROM (
      SELECT s.email AS address FROM core.subjects s
      WHERE s.id = v_request.subject_id AND s.email IS NOT NULL
      UNION
      SELECT c.previous_email FROM core.email_change_requests c
      WHERE c.subject_id = v_request.subject_id AND c.state = 'completed'
        AND c.previous_email IS NOT NULL AND c.completed_at > now() - interval '90 days'
    ) a;
  END IF;

  RETURN QUERY SELECT v_sessions, v_authenticators, v_codes, v_request.version + 1, v_released;
END
$$;

/** 0128's decision; the subject is locked before the request (F3). */
CREATE OR REPLACE FUNCTION core.decide_email_change(
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
SET row_security = off
AS $$
#variable_conflict use_column
DECLARE
  v core.email_change_requests%ROWTYPE;
  v_suspended TIMESTAMPTZ;
  v_subject_id UUID;
BEGIN
  -- 0132 (F3): the person's subject row first, then the request (see the header). The request's
  -- subject never changes, so reading it unlocked is enough to know which row to lock.
  SELECT r.subject_id INTO v_subject_id FROM core.email_change_requests r
  WHERE r.id = p_id AND r.tenant_id = core.current_tenant();
  IF FOUND THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;
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

  IF p_approve THEN
    SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v.subject_id FOR UPDATE;
    IF v_suspended IS NOT NULL THEN
      RETURN QUERY SELECT 'subject_suspended'::TEXT, v.version, v.subject_id;
      RETURN;
    END IF;
    IF core.recovery_separation_conflict(v.subject_id, p_decided_by, 'email_change')
       OR core.recovery_separation_conflict(v.subject_id, v.requested_by_subject_id, 'email_change') THEN
      RETURN QUERY SELECT 'separation_required'::TEXT, v.version, v.subject_id;
      RETURN;
    END IF;
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

/** 0128's completion; the subject is locked before the challenge and the request (F3). */
CREATE OR REPLACE FUNCTION core.complete_email_change(
  p_new_email TEXT, p_code_hmac BYTEA, p_email_key TEXT, p_ip_key TEXT
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID,
  email_change_id UUID, previous_email TEXT, revoked_sessions INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
SET row_security = off
AS $$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_email TEXT := core.normalize_email(p_new_email);
  r RECORD;
  v core.email_change_requests%ROWTYPE;
  v_previous TEXT;
  v_suspended TIMESTAMPTZ;
  v_revoked INTEGER;
  v_removed TEXT[];
  v_subject_id UUID;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry = 0 THEN
    v_retry := core.take_auth_rate('code_verify', 'email:' || p_email_key, 10, interval '15 minutes');
  END IF;
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- 0132 (F3): the person's subject row before the challenge and the request. Consuming the code
  -- locks the challenge, which a suspension holding the subject would supersede: the old order
  -- deadlocked with it. The live challenge for the address names the person; if a newer one
  -- replaces it in between, its person is locked below as before.
  SELECT c.subject_id INTO v_subject_id FROM core.email_challenges c
  WHERE c.purpose = 'email_change' AND c.email = v_email
    AND c.consumed_at IS NULL AND c.superseded_at IS NULL;
  IF v_subject_id IS NOT NULL THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
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

  SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v.subject_id FOR UPDATE;
  IF v_suspended IS NOT NULL THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0, v.tenant_id, v.subject_id, v.id, NULL::TEXT, 0;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v_email) THEN
    UPDATE core.email_change_requests SET state = 'expired', version = version + 1 WHERE id = v.id;
    RETURN QUERY SELECT 'email_unavailable'::TEXT, 0, v.tenant_id, v.subject_id, v.id, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT s.email INTO v_previous FROM core.subjects s WHERE s.id = v.subject_id;
  UPDATE core.subjects SET email = v_email, version = version + 1 WHERE id = v.subject_id;
  UPDATE core.email_change_requests
  SET state = 'completed', completed_at = now(), previous_email = v_previous, version = version + 1
  WHERE id = v.id;

  v_removed := core.revoke_subject_identities(v.subject_id, v.tenant_id, 'email_change');

  IF v_previous IS NOT NULL THEN
    PERFORM core.supersede_email_challenge('sign_in', v_previous);
    INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
    VALUES (
      gen_random_uuid(), 'email_changed_notice', v_previous,
      jsonb_build_object('removedSignIns', to_jsonb(v_removed)), 'pending',
      now() + interval '1 day'
    );
  END IF;

  PERFORM set_config('app.current_tenant', v.tenant_id::TEXT, true);
  v_revoked := core.revoke_subject_sessions(v.subject_id, 'email_changed');

  RETURN QUERY SELECT 'completed'::TEXT, 0, v.tenant_id, v.subject_id, v.id, v_previous, v_revoked;
END
$$;

-- ---------------------------------------------------------------------------
-- F2 + F3. A suspension: the person first, and what they approved closes too
-- ---------------------------------------------------------------------------

/**
 * 0129's decision, plus (F3) the subject locked before the request, and (F2) the suspended
 * person's approved email changes awaiting their code, approved resets with an open window and
 * pending invitations closed — each listed in `closed_requests` for the API to audit.
 */
CREATE OR REPLACE FUNCTION core.decide_subject_suspension(
  p_request_id UUID,
  p_decider UUID,
  p_approve BOOLEAN,
  p_reason TEXT,
  p_expected_version INTEGER
) RETURNS TABLE (
  revoked_sessions       INTEGER,
  revoked_authenticators INTEGER,
  revoked_identities     INTEGER,
  new_version            INTEGER,
  closed_requests        JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
SET row_security = off
AS $$
DECLARE
  v_request core.subject_suspensions;
  v_subject core.subjects;
  v_sessions INTEGER := 0;
  v_authenticators INTEGER := 0;
  v_count INTEGER;
  v_removed TEXT[] := ARRAY[]::TEXT[];
  v_closed JSONB := '[]'::jsonb;
  v_part JSONB;
  v_email TEXT;
  v_subject_id UUID;
  v_invitation UUID;
BEGIN
  -- 0132 (F3): the person's subject row first, then the request (see the header). The request's
  -- subject never changes, so reading it unlocked is enough to know which row to lock.
  SELECT r.subject_id INTO v_subject_id FROM core.subject_suspensions r
  WHERE r.id = p_request_id AND r.tenant_id = core.current_tenant();
  IF FOUND THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;
  SELECT * INTO v_request FROM core.subject_suspensions
  WHERE id = p_request_id AND tenant_id = core.current_tenant()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUSPENSION_NOT_FOUND: no such request' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_request.version <> p_expected_version THEN
    RAISE EXCEPTION 'SUSPENSION_VERSION_MISMATCH: current version is %', v_request.version
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_request.state <> 'pending' THEN
    RAISE EXCEPTION 'SUSPENSION_ALREADY_DECIDED: the request is %', v_request.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_decider = v_request.requested_by_subject_id THEN
    RAISE EXCEPTION 'SUSPENSION_SELF_APPROVAL: the proposer cannot decide' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decider = v_request.subject_id THEN
    RAISE EXCEPTION 'SUSPENSION_SELF_TARGET: the person cannot decide' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_subject FROM core.subjects
  WHERE id = v_request.subject_id AND tenant_id = v_request.tenant_id
  FOR UPDATE;

  IF p_approve THEN
    IF (v_request.action = 'suspend') <> (v_subject.suspended_at IS NULL) THEN
      RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person''s state changed since the proposal'
        USING ERRCODE = 'check_violation';
    END IF;
    IF core.recovery_separation_conflict(v_request.subject_id, p_decider, 'suspension')
       OR core.recovery_separation_conflict(v_request.subject_id, v_request.requested_by_subject_id, 'suspension') THEN
      RAISE EXCEPTION 'SUSPENSION_SEPARATION_REQUIRED: the proposer or decider took part in a recent email change or MFA reset of this person'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE core.subject_suspensions
  SET state = CASE WHEN p_approve THEN 'approved'::core.mfa_reset_state ELSE 'rejected' END,
      decided_by_subject_id = p_decider,
      decided_at = now(),
      decision_reason = p_reason,
      enrolment_window_until = CASE WHEN p_approve AND action = 'reinstate' THEN now() + interval '24 hours' END,
      version = version + 1
  WHERE id = v_request.id;

  IF p_approve AND v_request.action = 'suspend' THEN
    UPDATE core.subjects SET suspended_at = now(), version = version + 1 WHERE id = v_subject.id;

    -- The person's own recovery requests (S-M1). An email change's code dies with its request.
    FOR v_email IN
      SELECT c.new_email FROM core.email_change_requests c
      WHERE c.subject_id = v_subject.id AND c.state IN ('pending', 'approved')
    LOOP
      PERFORM core.supersede_email_challenge('email_change', v_email);
    END LOOP;
    WITH closed AS (
      UPDATE core.email_change_requests
      SET state = 'expired', closed_reason = 'subject_suspended', version = version + 1
      WHERE subject_id = v_subject.id AND state IN ('pending', 'approved')
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'email_change_request', 'id', id, 'reason', 'subject_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.mfa_reset_requests
      SET state = 'rejected', closed_reason = 'subject_suspended', decided_at = now(), version = version + 1
      WHERE subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', id, 'reason', 'subject_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    -- An approved reset's open window ends with the suspension (`mfa_reset_window_open`).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', r.id, 'reason', 'window_closed')), '[]')
    INTO v_part FROM core.mfa_reset_requests r
    WHERE r.subject_id = v_subject.id AND r.state = 'approved' AND r.enrolment_window_until > now();
    v_closed := v_closed || v_part;

    -- What the person proposed and nobody decided yet (S-L1).
    FOR v_email IN
      SELECT c.new_email FROM core.email_change_requests c
      WHERE c.requested_by_subject_id = v_subject.id AND c.state IN ('pending', 'approved')
    LOOP
      PERFORM core.supersede_email_challenge('email_change', v_email);
    END LOOP;
    WITH closed AS (
      UPDATE core.email_change_requests
      SET state = 'expired', closed_reason = 'proposer_suspended', version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state IN ('pending', 'approved')
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'email_change_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.mfa_reset_requests
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.subject_suspensions
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'subject_suspension', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.role_grant_requests
      SET state = 'withdrawn', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'role_grant_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.role_revocation_requests
      SET state = 'withdrawn', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'role_revocation_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.registry_proposals
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE proposed_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'registry_proposal', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.registry_publication_drafts
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE proposed_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'registry_publication_draft', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.break_glass_elevations
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'break_glass_elevation', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    -- 0132 (F2): what the person approved or created that has not taken effect yet. An approved
    -- email change still waiting for its code, an approved reset whose enrolment window is open,
    -- and a pending invitation all act on the approver's word later; a suspended approver's word
    -- no longer counts. Decided and completed requests stay as they are (frozen history).
    FOR v_email IN
      SELECT c.new_email FROM core.email_change_requests c
      WHERE c.decided_by_subject_id = v_subject.id AND c.state = 'approved'
    LOOP
      PERFORM core.supersede_email_challenge('email_change', v_email);
    END LOOP;
    WITH closed AS (
      UPDATE core.email_change_requests
      SET state = 'expired', closed_reason = 'approver_suspended', version = version + 1
      WHERE decided_by_subject_id = v_subject.id AND state = 'approved'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'email_change_request', 'id', id, 'reason', 'approver_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.mfa_reset_requests
      SET closed_reason = 'approver_suspended', version = version + 1
      WHERE decided_by_subject_id = v_subject.id AND state = 'approved' AND closed_reason IS NULL
        AND enrolment_window_until > now()
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', id, 'reason', 'approver_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    FOR v_invitation IN
      SELECT i.id FROM core.invitations i
      WHERE i.invited_by_subject_id = v_subject.id AND i.state = 'pending'
    LOOP
      UPDATE core.email_challenges SET superseded_at = now()
      WHERE invitation_id = v_invitation AND consumed_at IS NULL AND superseded_at IS NULL;
      UPDATE core.email_outbox
      SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
      WHERE invitation_id = v_invitation AND state = 'pending';
    END LOOP;
    WITH closed AS (
      UPDATE core.invitations
      SET state = 'expired', closed_reason = 'inviter_suspended', version = version + 1
      WHERE invited_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'invitation', 'id', id, 'reason', 'inviter_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    -- 0129 (L-1): an approved elevation ends with the suspension. Reinstating does not bring it
    -- back; a new one needs a new approval.
    v_closed := v_closed || core.end_subject_elevations(v_subject.id, v_subject.tenant_id, p_decider, 'subject_suspended');

    UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'suspension'
    WHERE subject_id = v_subject.id AND tenant_id = v_subject.tenant_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_count;

    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'suspension'
    WHERE subject_id = v_subject.id AND tenant_id = v_subject.tenant_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_authenticators + v_count;

    UPDATE core.recovery_codes SET voided_at = now()
    WHERE subject_id = v_subject.id AND tenant_id = v_subject.tenant_id
      AND consumed_at IS NULL AND voided_at IS NULL;

    v_removed := core.revoke_subject_identities(v_subject.id, v_subject.tenant_id, 'suspension');

    DELETE FROM core.oidc_login_transactions t
    WHERE t.completed_at IS NULL
      AND t.session_id IN (SELECT s.id FROM core.sessions s WHERE s.subject_id = v_subject.id);
    DELETE FROM core.wallet_binding_challenges c
    WHERE c.subject_id = v_subject.id AND c.tenant_id = v_subject.tenant_id AND c.consumed_at IS NULL;
    DELETE FROM core.webauthn_challenges c
    WHERE c.subject_id = v_subject.id AND c.tenant_id = v_subject.tenant_id AND c.consumed_at IS NULL;
    IF v_subject.email IS NOT NULL THEN
      PERFORM core.supersede_email_challenge('sign_in', v_subject.email);
    END IF;

    v_sessions := core.revoke_subject_sessions(v_subject.id, 'suspension');

    IF v_subject.email IS NOT NULL THEN
      INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
      VALUES (
        gen_random_uuid(), 'account_suspended_notice', v_subject.email,
        jsonb_build_object('removedSignIns', to_jsonb(v_removed)), 'pending', now() + interval '1 day'
      );
    END IF;
  ELSIF p_approve THEN
    UPDATE core.subjects SET suspended_at = NULL, version = version + 1 WHERE id = v_subject.id;
    IF v_subject.email IS NOT NULL THEN
      INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
      VALUES (
        gen_random_uuid(), 'account_reinstated_notice', v_subject.email, '{}'::jsonb, 'pending',
        now() + interval '1 day'
      );
    END IF;
  END IF;

  RETURN QUERY SELECT v_sessions, v_authenticators, COALESCE(array_length(v_removed, 1), 0),
    v_request.version + 1, v_closed;
END
$$;

/** 0128's window; a window closed by its approver's suspension does not count (F2). */
CREATE OR REPLACE FUNCTION core.mfa_reset_window_open(p_subject_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = core, pg_temp
AS $$
  WITH barrier AS (
    SELECT GREATEST(
      (SELECT max(s.decided_at) FROM core.subject_suspensions s
       WHERE s.subject_id = p_subject_id AND s.action = 'suspend' AND s.state = 'approved'),
      (SELECT max(c.completed_at) FROM core.email_change_requests c
       WHERE c.subject_id = p_subject_id AND c.state = 'completed')
    ) AS at
  )
  SELECT EXISTS (
    SELECT 1 FROM core.mfa_reset_requests r, barrier b
    WHERE r.subject_id = p_subject_id AND r.state = 'approved' AND r.enrolment_window_until > now()
      AND r.closed_reason IS NULL
      AND (b.at IS NULL OR r.decided_at > b.at)
  ) OR EXISTS (
    SELECT 1 FROM core.subject_suspensions r, barrier b
    WHERE r.subject_id = p_subject_id AND r.action = 'reinstate' AND r.state = 'approved'
      AND r.enrolment_window_until > now()
      AND (b.at IS NULL OR r.decided_at > b.at)
  )
$$;

-- ---------------------------------------------------------------------------
-- F5. The actor and reset guards refuse when they read nothing
-- ---------------------------------------------------------------------------

/** 0128's guard; an actor it cannot read refuses (F5). */
CREATE OR REPLACE FUNCTION core.refuse_suspended_actor() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_new JSONB := to_jsonb(NEW);
  v_old JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  v_column TEXT;
  v_actor UUID;
  v_suspended TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.closed_reason IS NOT NULL THEN
    RAISE EXCEPTION 'REQUEST_CLOSED_REASON_RESERVED: only a suspension closes a request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    v_actor := (v_new ->> v_column)::UUID;
    CONTINUE WHEN v_actor IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND v_actor IS NOT DISTINCT FROM (v_old ->> v_column)::UUID;
    -- 0132 (F5): an actor that cannot be read refuses. The row's foreign key says the actor
    -- exists in the row's tenant, so only an owner filtered by RLS reads nothing here.
    SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v_actor;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACTOR_UNREADABLE: actor % of % cannot be read', v_actor, TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_suspended IS NOT NULL THEN
      RAISE EXCEPTION 'ACTOR_SUSPENDED: a suspended account takes part in no decision'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

/** 0128's guard; a person it cannot read refuses (F5). */
CREATE OR REPLACE FUNCTION core.mfa_reset_separation_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_suspended TIMESTAMPTZ;
BEGIN
  SELECT suspended_at INTO v_suspended FROM core.subjects
  WHERE id = NEW.subject_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  -- 0132 (F5): a person that cannot be read refuses (the separation below would read nothing too).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_RESET_SUBJECT_UNREADABLE: subject % cannot be read', NEW.subject_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_suspended IS NOT NULL THEN
    RAISE EXCEPTION 'MFA_RESET_SUBJECT_SUSPENDED: the person is suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.origin <> 'admin' THEN
    RETURN NEW;
  END IF;
  IF core.recovery_separation_conflict(NEW.subject_id, NEW.requested_by_subject_id, 'mfa_reset') THEN
    RAISE EXCEPTION 'MFA_RESET_SEPARATION_REQUIRED: the proposer took part in a recent email change or suspension of this person'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

SELECT set_config('lock_timeout', '0', true);
