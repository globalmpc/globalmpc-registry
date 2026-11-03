-- An elevation and the creation window do not outlive what they stood on — re-review of 0128.
--
-- L-1. A suspension revoked every session and factor but left an approved break-glass elevation
-- `active`: once two admins reinstated the person and they enrolled a new passkey, the session
-- resolved `break_glass` again until `expires_at`, with no new approval. Now an approved
-- suspension releases the person's active elevations in the same transaction (the existing
-- `released` state; the suspension's decider is the releaser, cause `subject_suspended`), and the
-- API audits each one with the other requests the suspension closed. An approved MFA reset does
-- the same (cause `mfa_reset`): the elevation was approved for a person signed in with the factors
-- the reset removes, and 02 §2.6 ends an elevation early by release, never by shortening it.
--
-- L-2. The 24-hour first-enrolment window after account creation ignored an address change: two
-- admins could move a one-hour-old account to an address they read, sign in there and enrol a
-- factor. 0128 gave the reset and reinstatement windows a barrier (the latest approved suspension
-- or completed email change); the creation window now has the same one — it is open only while no
-- email change of the person has completed and no suspension of them has been approved.
--
-- | Case | Identity namespace | Authority | Frozen vs live | Status priority | Result |
-- | --- | --- | --- | --- | --- | --- |
-- | Suspension approved, elevation active | the person, its tenant | the two suspending admins | live: the elevation; frozen: its approval, incident record, audit | suspension before the elevation's expiry | `released`, cause `subject_suspended`, audited |
-- | MFA reset approved, elevation active | same | the two resetting admins | same | reset before expiry | `released`, cause `mfa_reset`, audited |
-- | Account under 24 h old after an email change or a suspension | the person | — | `created_at` kept | the later event wins | `MFA_ENROLMENT_WINDOW_CLOSED` |
-- | Account under 24 h old, invitation only | the person | — | — | — | enrolment allowed, as before |

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------

/**
 * Releases the person's approved, unexpired elevations: the state a security operator's release
 * writes, with the deciding admin as releaser (never the person: the deciders of a suspension and
 * of a reset are not the person). Returns `[{"kind", "id", "reason"}]` for the audit.
 * Only the two decision functions call it.
 */
CREATE FUNCTION core.end_subject_elevations(
  p_subject_id UUID,
  p_tenant_id UUID,
  p_releaser UUID,
  p_cause TEXT
) RETURNS JSONB
LANGUAGE sql
VOLATILE
SET search_path = core, pg_temp
AS $$
  WITH released AS (
    UPDATE core.break_glass_elevations
    SET state = 'released',
        released_by_subject_id = p_releaser,
        released_at = now(),
        release_cause = p_cause,
        release_recovery_verification = CASE p_cause
          WHEN 'subject_suspended' THEN 'Every session and factor of the person was revoked by the suspension'
          ELSE 'Every session and factor of the person was revoked by the MFA reset'
        END,
        version = version + 1
    WHERE subject_id = p_subject_id AND tenant_id = p_tenant_id
      AND state = 'active' AND expires_at > now()
    RETURNING id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'break_glass_elevation', 'id', id, 'reason', p_cause)), '[]')
  FROM released
$$;

REVOKE EXECUTE ON FUNCTION core.end_subject_elevations(UUID, UUID, UUID, TEXT) FROM PUBLIC;

/**
 * The first-enrolment window after account creation: 24 hours, and only while no email change of
 * the person has completed and no suspension of them has been approved — the barrier 0128 gave
 * the reset and reinstatement windows.
 */
CREATE FUNCTION core.mfa_creation_window_open(p_subject_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = p_subject_id AND s.created_at > now() - interval '24 hours'
  )
  AND NOT EXISTS (
    SELECT 1 FROM core.email_change_requests c
    WHERE c.subject_id = p_subject_id AND c.state = 'completed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM core.subject_suspensions r
    WHERE r.subject_id = p_subject_id AND r.action = 'suspend' AND r.state = 'approved'
  )
$$;

REVOKE EXECUTE ON FUNCTION core.mfa_creation_window_open(UUID) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. A suspension ends the person's active elevation (L-1)
-- ---------------------------------------------------------------------------

/** 0128's decision, plus: an approved suspension ends the person's active elevation (`closed_requests`). */
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
BEGIN
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

-- ---------------------------------------------------------------------------
-- 3. An approved MFA reset ends it too
-- ---------------------------------------------------------------------------

DROP FUNCTION core.decide_mfa_reset(UUID, UUID, BOOLEAN, TEXT, INTEGER);

/**
 * 0128's decision, plus: an approved reset ends the person's active elevation.
 * `released_elevations` lists them — `[{"kind", "id", "reason"}]` — for the API to audit.
 */
CREATE FUNCTION core.decide_mfa_reset(
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

REVOKE EXECUTE ON FUNCTION core.decide_mfa_reset(UUID, UUID, BOOLEAN, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.decide_mfa_reset(UUID, UUID, BOOLEAN, TEXT, INTEGER) TO mpc_app;

-- ---------------------------------------------------------------------------
-- 4. The creation window ends at an address change or a suspension (L-2)
-- ---------------------------------------------------------------------------

/** 0116's enrolment rules, with the creation window of `core.mfa_creation_window_open`. */
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

/** 0118's bootstrap re-run, with the same creation window. */
CREATE OR REPLACE FUNCTION core.open_bootstrap_enrolment_window(p_subject_id UUID)
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
  IF core.mfa_creation_window_open(p_subject_id) THEN
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

SELECT set_config('lock_timeout', '0', true);
