-- Admin MFA reset — account authentication WP3, journey 6 ("lost everything").
--
-- A person who lost every passkey, TOTP and recovery code cannot raise any session past aal1, and
-- an aal1 session may enrol only inside a first-enrolment window (0116). This opens one, by two
-- people: a proposal (a plain insert, 0115) and a decision by someone else. Approval, in one
-- transaction:
--
-- - revokes every passkey and TOTP of the subject (pending setups too) and voids its unused
--   recovery codes — whatever was lost or stolen stops working;
-- - ends every session of the subject (`core.revoke_subject_sessions`, reason `mfa_reset`);
-- - opens a 24-hour window in which an aal1 session of the subject may enrol a first factor.
--
-- Nothing else changes: role bindings, wallets, signed attestations and decisions, and the audit
-- trail stay as they are (AC-27). The reset never names an authenticator to add — admins cannot
-- attach one to another subject (plan §5); the person enrols their own after signing in with the
-- first factor.

/**
 * Decides a pending reset. `p_decider` is the deciding admin's subject (authorized by the API);
 * the proposer and the subject itself are refused as decider, here and by the table's CHECKs. Raises `MFA_RESET_*` codes for
 * the API to map; returns what approval revoked (zeros for a rejection) and the new version.
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
  END IF;

  RETURN QUERY SELECT v_sessions, v_authenticators, v_codes, v_request.version + 1;
END
$$;

REVOKE EXECUTE ON FUNCTION core.decide_mfa_reset(UUID, UUID, BOOLEAN, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.decide_mfa_reset(UUID, UUID, BOOLEAN, TEXT, INTEGER) TO mpc_app;
