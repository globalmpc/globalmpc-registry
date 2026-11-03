-- Account recovery hardening, second pass — re-review of 0118.
--
-- 1. **Notice outlives the separation (L5).** 0118 ended the recovery separation and the memory of
--    a previous address at the same 30 days. One minute later the same admin who moved an address
--    could approve a reset, and the notice reached only the address they had moved it to. The
--    separation stays at 30 days; the previous address is now kept, and told of an approved reset,
--    for 90 days, so a takeover attempted right after the separation lapses still reaches the
--    owner at the address they still read.
--
-- 2. **The previous address is not the application's to read (L6).** `previous_email` exists for
--    the reset notice only, which the database queues itself. The application role keeps SELECT
--    on every other column of `core.email_change_requests` and loses it on that one; the API
--    names its columns instead of `SELECT *`.

-- ---------------------------------------------------------------------------
-- 2. Column-level read (L6)
-- ---------------------------------------------------------------------------

REVOKE SELECT ON core.email_change_requests FROM mpc_app;
GRANT SELECT (
  id, tenant_id, subject_id, new_email, reason, requested_by_subject_id, requested_at, state,
  decided_by_subject_id, decided_at, decision_reason, completed_at, version
) ON core.email_change_requests TO mpc_app;

-- ---------------------------------------------------------------------------
-- 1. 90-day notice (L5)
-- ---------------------------------------------------------------------------

/** 0118's decision; the reset notice reaches every address left in the last 90 days. */
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

    -- No code and no link: the mail only says it happened and whom to call. Every address the
    -- subject left in the last 90 days — longer than the 30-day separation (0119).
    INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
    SELECT gen_random_uuid(), 'mfa_reset_notice', a.address, '{}'::jsonb, 'pending', now() + interval '1 day'
    FROM (
      SELECT s.email AS address FROM core.subjects s
      WHERE s.id = v_request.subject_id AND s.email IS NOT NULL
      UNION
      SELECT c.previous_email FROM core.email_change_requests c
      WHERE c.subject_id = v_request.subject_id AND c.state = 'completed'
        AND c.previous_email IS NOT NULL AND c.completed_at > now() - interval '90 days'
    ) a;
  END IF;

  RETURN QUERY SELECT v_sessions, v_authenticators, v_codes, v_request.version + 1;
END
$$;

/** 0118's purge; a previous address is forgotten after the 90 days the notice uses it. */
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
  WHERE previous_email IS NOT NULL AND completed_at <= now() - interval '90 days';

  RETURN QUERY SELECT v_challenges, v_mail, v_rate;
END
$$;
