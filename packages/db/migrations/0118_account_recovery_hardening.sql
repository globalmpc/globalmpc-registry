-- Account recovery hardening — security review of account authentication WP2 + WP3.
--
-- 1. **Recovery separation (M1).** An email change (0114) and an admin MFA reset (0117) are each
--    two-person, but chained they hand an account to whoever controls both: two admins move the
--    address to a mailbox they read, then reset the factors, then enrol their own passkey from
--    an aal1 email-code session. So the two flows exclude each other's people for 30 days:
--
--    | Refused                                     | when the actor, for the same subject, was the proposer or decider of… |
--    |---------------------------------------------|------------------------------------------------------------------------|
--    | proposing an MFA reset (insert trigger)     | an email change pending, approved or completed in the last 30 days     |
--    | approving an MFA reset (proposer, decider)  | the same                                                               |
--    | proposing an email change                   | an admin MFA reset pending or approved in the last 30 days             |
--    | approving an email change (proposer, decider) | the same                                                             |
--
--    Rejections are never refused: saying no cannot take an account. Email changes count while
--    pending or approved, not only once completed — otherwise approve, reset, then complete would
--    slip through. "In the last 30 days" is the latest of the request's own timestamps. Every
--    check locks the subject row first, so a proposal on one side and an approval on the other
--    cannot pass each other's check concurrently.
--
--    An approved reset also mails `mfa_reset_notice` to the subject's current address and to
--    every address it was moved away from in the last 30 days — the owner the chain would have
--    locked out hears about it at the address they still read. A completed change now keeps that
--    previous address (`previous_email`) for 30 days for this purpose only; the purge clears it.
--
-- 2. **Bootstrap enrolment window (M2).** A person older than 24 hours with no factor could never
--    enrol: only an admin reset reopens the window, and the first operator has no second admin.
--    `core.open_bootstrap_enrolment_window` (migration connection only) records an approved reset
--    with `origin = 'bootstrap'` so `core.mfa_reset_window_open` stays the one source of truth. It
--    refuses (opens nothing) once the subject holds a passkey or TOTP and never touches a factor.
--
-- 3. **No address, no change (L3).** `core.request_email_change` refuses a subject without an
--    address (`no_address`): attaching a first address is invitation acceptance, not a change.
--
-- 4. **One lock order (L1).** Subject before sessions everywhere: `core.mfa_lock_session` used to
--    lock the session and then the subject, so two MFA calls of one person from two sessions
--    could deadlock once one of them revoked the other's session. `core.revoke_subject_sessions`
--    now locks the subject first too.
--
-- 5. **Subject creation time (L2).** The first-enrolment window runs from `subjects.created_at`,
--    so the application role may no longer write it, and no row may claim a future creation.
--
-- 6. **Saturated sign-in addresses (L4).** `core.operational_gauges` reports how many addresses
--    are at their code-request limit right now. The per-address limit lets anyone delay a known
--    address's sign-in for 15 minutes; that is accepted (threat model T10) and watched.

-- ---------------------------------------------------------------------------
-- 5. Subject creation time (L2)
-- ---------------------------------------------------------------------------

REVOKE INSERT (created_at) ON core.subjects FROM mpc_app;
GRANT INSERT (id, tenant_id, kind, display_name, version, assurance_level, governance_wallet_id)
  ON core.subjects TO mpc_app;

-- Five minutes of clock skew between the API and database hosts. Validated against existing rows.
ALTER TABLE core.subjects
  ADD CONSTRAINT subjects_created_at_not_future CHECK (created_at <= now() + interval '5 minutes');

-- ---------------------------------------------------------------------------
-- 1. Recovery separation (M1) — schema
-- ---------------------------------------------------------------------------

ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_template_check;
ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_template_check CHECK (template IN (
  'sign_in_code', 'invitation_link', 'invitation_code',
  'email_change_code', 'email_changed_notice', 'mfa_reset_notice'
));

-- The address a completed change moved away from. Kept 30 days (purge) for the reset notice.
ALTER TABLE core.email_change_requests
  ADD COLUMN previous_email TEXT
    CHECK (previous_email IS NULL OR previous_email = core.normalize_email(previous_email)),
  ADD CONSTRAINT email_change_previous_only_completed
    CHECK (previous_email IS NULL OR state = 'completed');

-- ---------------------------------------------------------------------------
-- 2. Bootstrap enrolment window (M2) — schema
-- ---------------------------------------------------------------------------

-- `origin` is not in the application role's INSERT grant: a proposal is always `admin`.
ALTER TABLE core.mfa_reset_requests
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'admin' CHECK (origin IN ('admin', 'bootstrap'));
ALTER TABLE core.mfa_reset_requests ALTER COLUMN requested_by_subject_id DROP NOT NULL;

ALTER TABLE core.mfa_reset_requests DROP CONSTRAINT mfa_reset_decision_shape;
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_decision_shape CHECK (
  (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL
    AND enrolment_window_until IS NULL)
  OR (state = 'rejected' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND enrolment_window_until IS NULL)
  OR (state = 'approved' AND decided_at IS NOT NULL
    AND enrolment_window_until = decided_at + interval '24 hours'
    AND (decided_by_subject_id IS NOT NULL) = (origin = 'admin'))
);
-- An admin reset has a proposer (and, decided, a decider: above). A bootstrap row has neither
-- and exists only approved — it is the deploy runner's act, recorded in the audit as such.
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_origin_shape CHECK (
  (origin = 'admin') = (requested_by_subject_id IS NOT NULL)
  AND (origin = 'admin' OR state = 'approved')
);

-- ---------------------------------------------------------------------------
-- 1. Recovery separation (M1) — rule
-- ---------------------------------------------------------------------------

/**
 * Whether `p_actor` took part, for `p_subject_id`, in a recent recovery of the other kind.
 * `p_side` is the flow being decided now: `mfa_reset` looks at email changes, `email_change` at
 * admin MFA resets. Not granted: called by the SECURITY DEFINER functions and trigger below.
 */
CREATE FUNCTION core.recovery_separation_conflict(p_subject_id UUID, p_actor UUID, p_side TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = core, pg_temp
AS $$
BEGIN
  IF p_side = 'mfa_reset' THEN
    RETURN EXISTS (
      SELECT 1 FROM core.email_change_requests c
      WHERE c.subject_id = p_subject_id
        AND c.state IN ('pending', 'approved', 'completed')
        AND p_actor IN (c.requested_by_subject_id, c.decided_by_subject_id)
        AND GREATEST(c.requested_at, c.decided_at, c.completed_at) > now() - interval '30 days'
    );
  ELSIF p_side = 'email_change' THEN
    RETURN EXISTS (
      SELECT 1 FROM core.mfa_reset_requests r
      WHERE r.subject_id = p_subject_id
        AND r.origin = 'admin'
        AND r.state IN ('pending', 'approved')
        AND p_actor IN (r.requested_by_subject_id, r.decided_by_subject_id)
        AND GREATEST(r.requested_at, r.decided_at) > now() - interval '30 days'
    );
  END IF;
  RAISE EXCEPTION 'unknown recovery side %', p_side USING ERRCODE = 'invalid_parameter_value';
END
$$;

REVOKE EXECUTE ON FUNCTION core.recovery_separation_conflict(UUID, UUID, TEXT) FROM PUBLIC;

/**
 * A reset proposal is a plain insert by the API (0115), so the rule is a trigger. It locks the
 * subject so a concurrent email-change approval sees this proposal, or this sees that approval.
 */
CREATE FUNCTION core.mfa_reset_separation_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NEW.origin <> 'admin' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM core.subjects WHERE id = NEW.subject_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF core.recovery_separation_conflict(NEW.subject_id, NEW.requested_by_subject_id, 'mfa_reset') THEN
    RAISE EXCEPTION 'MFA_RESET_SEPARATION_REQUIRED: the proposer took part in a recent email change of this person'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION core.mfa_reset_separation_guard() FROM PUBLIC;

CREATE TRIGGER mfa_reset_requests_separation
  BEFORE INSERT ON core.mfa_reset_requests
  FOR EACH ROW EXECUTE FUNCTION core.mfa_reset_separation_guard();

/**
 * 0117's decision, plus: approval is refused while the proposer or the decider took part in a
 * recent email change of the subject, and approval queues `mfa_reset_notice` to the current
 * address and to every address the subject left in the last 30 days.
 */
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
  new_version            INTEGER
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
BEGIN
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
    -- Subject before sessions (L1); also serializes against the email-change checks.
    PERFORM 1 FROM core.subjects WHERE id = v_request.subject_id FOR UPDATE;
    IF core.recovery_separation_conflict(v_request.subject_id, p_decider, 'mfa_reset')
       OR core.recovery_separation_conflict(v_request.subject_id, v_request.requested_by_subject_id, 'mfa_reset') THEN
      RAISE EXCEPTION 'MFA_RESET_SEPARATION_REQUIRED: the proposer or decider took part in a recent email change of this person'
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

    v_sessions := core.revoke_subject_sessions(v_request.subject_id, 'mfa_reset');

    -- No code and no link: the mail only says it happened and whom to call.
    INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
    SELECT gen_random_uuid(), 'mfa_reset_notice', a.address, '{}'::jsonb, 'pending', now() + interval '1 day'
    FROM (
      SELECT s.email AS address FROM core.subjects s
      WHERE s.id = v_request.subject_id AND s.email IS NOT NULL
      UNION
      SELECT c.previous_email FROM core.email_change_requests c
      WHERE c.subject_id = v_request.subject_id AND c.state = 'completed'
        AND c.previous_email IS NOT NULL AND c.completed_at > now() - interval '30 days'
    ) a;
  END IF;

  RETURN QUERY SELECT v_sessions, v_authenticators, v_codes, v_request.version + 1;
END
$$;

/**
 * 0114's proposal, plus `no_address` (L3: the subject has no address to change) and
 * `separation_required` (M1: the proposer took part in a recent admin MFA reset of the subject).
 */
CREATE OR REPLACE FUNCTION core.request_email_change(
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
  v_current TEXT;
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

  -- Request rows before the subject, as every other email-change path (L1).
  SELECT s.email INTO v_current FROM core.subjects s WHERE s.id = p_subject_id FOR UPDATE;
  IF v_current IS NULL THEN
    RETURN QUERY SELECT 'no_address'::TEXT;
    RETURN;
  END IF;
  IF core.recovery_separation_conflict(p_subject_id, p_requested_by, 'email_change') THEN
    RETURN QUERY SELECT 'separation_required'::TEXT;
    RETURN;
  END IF;

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
 * 0114's decision, plus `separation_required` on approval when the proposer or the decider took
 * part in a recent admin MFA reset of the subject. A rejection is never refused.
 */
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

  IF p_approve THEN
    PERFORM 1 FROM core.subjects s WHERE s.id = v.subject_id FOR UPDATE;
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

/** 0114's completion, plus keeping the address moved away from (`previous_email`). */
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
  SET state = 'completed', completed_at = now(), previous_email = v_previous, version = version + 1
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

/** 0114's purge, plus forgetting a previous address once the 30 days it serves are over. */
CREATE OR REPLACE FUNCTION core.purge_email_auth_records()
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

  UPDATE core.email_change_requests SET previous_email = NULL
  WHERE previous_email IS NOT NULL AND completed_at <= now() - interval '30 days';

  RETURN QUERY SELECT v_challenges, v_mail, v_rate;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Bootstrap enrolment window (M2) — function
-- ---------------------------------------------------------------------------

/**
 * Opens a 24-hour first-enrolment window for a person who holds no passkey or TOTP — the
 * bootstrap CLI's recovery for a first operator who missed the 24 hours after creation. Run over
 * the migration connection only (not granted to the application role).
 *
 * `opened` false with a `window_until`: a window is already open (creation or an earlier run),
 * nothing new is recorded. `opened` false and no `window_until`: the person holds a factor, so
 * nothing is opened — from then on only a two-person admin reset reopens one. Never touches an
 * authenticator, a recovery code or a session.
 */
CREATE FUNCTION core.open_bootstrap_enrolment_window(p_subject_id UUID)
RETURNS TABLE (opened BOOLEAN, reset_id UUID, window_until TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_subject core.subjects;
  v_id UUID;
  v_until TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_subject FROM core.subjects WHERE id = p_subject_id AND kind = 'person' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such person %', p_subject_id USING ERRCODE = 'no_data_found';
  END IF;
  -- The functions below and the table's policy read the current tenant.
  PERFORM set_config('app.current_tenant', v_subject.tenant_id::TEXT, true);

  IF core.mfa_has_passkey(p_subject_id) OR core.mfa_has_totp(p_subject_id) THEN
    RETURN QUERY SELECT false, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF v_subject.created_at > now() - interval '24 hours' THEN
    RETURN QUERY SELECT false, NULL::UUID, v_subject.created_at + interval '24 hours';
    RETURN;
  END IF;
  SELECT r.id, r.enrolment_window_until INTO v_id, v_until FROM core.mfa_reset_requests r
  WHERE r.subject_id = p_subject_id AND r.state = 'approved' AND r.enrolment_window_until > now()
  ORDER BY r.enrolment_window_until DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_id, v_until;
    RETURN;
  END IF;

  v_id := gen_random_uuid();
  INSERT INTO core.mfa_reset_requests (
    id, tenant_id, subject_id, reason, requested_by_subject_id, state, decided_at,
    enrolment_window_until, origin
  ) VALUES (
    v_id, v_subject.tenant_id, p_subject_id,
    'Bootstrap re-run: no second factor enrolled', NULL, 'approved', now(),
    now() + interval '24 hours', 'bootstrap'
  );
  RETURN QUERY SELECT true, v_id, now() + interval '24 hours';
END
$$;

REVOKE EXECUTE ON FUNCTION core.open_bootstrap_enrolment_window(UUID) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4. One lock order (L1)
-- ---------------------------------------------------------------------------

/**
 * 0116's session lock with the order reversed: find the live session unlocked, lock its subject,
 * then lock the session and check again that it is live — a concurrent call of the same person
 * may have revoked it while this one waited for the subject.
 */
CREATE OR REPLACE FUNCTION core.mfa_lock_session(p_session_id UUID) RETURNS core.sessions
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions;
  v_subject UUID;
BEGIN
  SELECT subject_id INTO v_subject FROM core.sessions
  WHERE id = p_session_id
    AND tenant_id = core.current_tenant()
    AND revoked_at IS NULL
    AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_SESSION_INVALID: no live session in the current tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM core.subjects WHERE id = v_subject FOR UPDATE;
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
  RETURN v;
END
$$;

/** 0108's revocation, locking the subject before its sessions (L1). */
CREATE OR REPLACE FUNCTION core.revoke_subject_sessions(p_subject_id UUID, p_reason TEXT) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM 1 FROM core.subjects WHERE id = p_subject_id AND tenant_id = core.current_tenant() FOR UPDATE;
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = p_reason
  WHERE subject_id = p_subject_id AND tenant_id = core.current_tenant() AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Saturated sign-in addresses (L4)
-- ---------------------------------------------------------------------------

/**
 * 0041's gauges plus `email_code_addresses_limited{state="code_start"}`: addresses that have used
 * every code request of the current 15-minute window (5, 0114). A handful is people retrying; a
 * sustained crowd is someone holding known addresses out of sign-in.
 */
CREATE OR REPLACE FUNCTION core.operational_gauges()
RETURNS TABLE (metric TEXT, label TEXT, value BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT 'anchor_transactions'::TEXT, t.state::TEXT, COUNT(*)
  FROM chain.transactions t
  GROUP BY t.state

  UNION ALL

  SELECT 'outbox_pending'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.outbox
  WHERE published_at IS NULL

  UNION ALL

  SELECT 'uploads_quarantined'::TEXT, 'all'::TEXT, COUNT(*)
  FROM core.object_uploads
  WHERE state = 'quarantined'

  UNION ALL

  SELECT 'worker_seconds_since_heartbeat'::TEXT, h.worker_kind,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - h.last_seen_at)))::BIGINT)
  FROM core.worker_heartbeats h

  UNION ALL

  SELECT 'notification_deliveries'::TEXT, d.state, COUNT(*)
  FROM core.notification_deliveries d
  GROUP BY d.state

  UNION ALL

  -- No row while no proposal is open: an absent series, not a 0 that reads as "fresh".
  SELECT 'anchor_proposal_oldest_age_seconds'::TEXT, 'proposed'::TEXT,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MIN(p.created_at))))::BIGINT)
  FROM chain.anchor_proposals p
  WHERE p.state = 'proposed'
  HAVING COUNT(*) > 0

  UNION ALL

  SELECT 'email_code_addresses_limited'::TEXT, 'code_start'::TEXT, COUNT(*)
  FROM (
    SELECT e.bucket FROM core.auth_rate_events e
    WHERE e.action = 'code_start' AND e.bucket LIKE 'email:%'
      AND e.occurred_at > now() - interval '15 minutes'
    GROUP BY e.bucket
    HAVING COUNT(*) >= 5
  ) saturated
$$;
