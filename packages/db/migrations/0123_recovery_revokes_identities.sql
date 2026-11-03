-- Recovery revokes linked sign-in identities — security review of WP4 + WP5 (M3).
--
-- An MFA reset and an email change are the two recovery paths: each ends every session and,
-- for the reset, every second factor, so that whoever took the account loses it. A linked
-- Google / Microsoft identity survived both. Someone with a few minutes of aal2 access could
-- link their own Google account to the victim; after an approved reset they signed in with it
-- (aal1) inside the 24-hour first-enrolment window and enrolled a passkey before the owner —
-- who, at aal1, could not unlink it.
--
-- Now:
--
-- 1. `core.decide_mfa_reset` (0119's body, unchanged otherwise: separation rule, 90-day
--    notices) revokes every live identity of the subject in the approving transaction,
--    `revoked_reason = 'mfa_reset'`.
-- 2. `core.complete_email_change` (0118's body, unchanged otherwise) does the same,
--    `revoked_reason = 'email_change'`.
-- 3. Both notices carry `{"removedSignIns": [...]}` — provider names only, never an
--    identifier — so the mail can say which sign-ins have to be linked again. Rows queued
--    before this migration carry `{}`, which the worker renders as before.
--
-- Revoking frees the key (the unique index covers live rows only), so the owner can link the
-- same Google / Microsoft account again from an aal2 session. Only the subject's own rows in its
-- own tenant are touched.
--
-- | Identity / case | Namespace | Authority | Frozen vs live | Result |
-- | --- | --- | --- | --- | --- |
-- | Linked identity at an approved MFA reset | `(provider, issuer, subject_key)` of the reset subject, its tenant | Two-person reset decision (`decide_mfa_reset`) | Live row revoked; audit history kept | Revoked with the factors, same transaction |
-- | Linked identity at a completed email change | Same, for the changed subject | Code sent to the new address after a two-person decision | Same | Revoked with the sessions, same transaction |
-- | Notice contents | Provider names of the identities just revoked | The database, not the caller | Frozen in the outbox row | Names only; nothing that identifies the account at the provider |

/** 0119's decision, plus revoking the subject's linked identities on approval (M3). */
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
  v_removed TEXT[] := ARRAY[]::TEXT[];
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

    -- A linked identity is a way in like any factor: whoever linked it may not be the owner
    -- (M3, 0123). Only this subject's live rows, in its tenant.
    v_removed := core.revoke_subject_identities(v_request.subject_id, v_request.tenant_id, 'mfa_reset');

    v_sessions := core.revoke_subject_sessions(v_request.subject_id, 'mfa_reset');

    -- No code and no link: the mail only says it happened, which sign-ins to link again, and
    -- whom to call. Every address the subject left in the last 90 days — longer than the 30-day
    -- separation (0119).
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

  RETURN QUERY SELECT v_sessions, v_authenticators, v_codes, v_request.version + 1;
END
$$;

/**
 * Revokes every live linked identity of a subject in a tenant and returns the provider names
 * revoked (distinct, sorted) — for the notice, which names providers and nothing else.
 * Internal: called by the two recovery functions only.
 */
CREATE FUNCTION core.revoke_subject_identities(p_subject_id UUID, p_tenant_id UUID, p_reason TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_removed TEXT[];
BEGIN
  WITH revoked AS (
    UPDATE core.external_identities
    SET revoked_at = now(), revoked_reason = p_reason
    WHERE subject_id = p_subject_id AND tenant_id = p_tenant_id AND revoked_at IS NULL
    RETURNING provider
  )
  SELECT COALESCE(array_agg(DISTINCT provider::TEXT ORDER BY provider::TEXT), ARRAY[]::TEXT[])
  INTO v_removed FROM revoked;
  RETURN v_removed;
END
$$;

REVOKE EXECUTE ON FUNCTION core.revoke_subject_identities(UUID, UUID, TEXT) FROM PUBLIC;

/** 0118's completion, plus revoking the subject's linked identities (M3). */
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
  v_removed TEXT[];
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

  -- An email change is a recovery path: a sign-in someone else linked must not survive it (M3).
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

  -- `revoke_subject_sessions` ends only sessions of the current tenant; set it for this call.
  PERFORM set_config('app.current_tenant', v.tenant_id::TEXT, true);
  v_revoked := core.revoke_subject_sessions(v.subject_id, 'email_changed');

  RETURN QUERY SELECT 'completed'::TEXT, 0, v.tenant_id, v.subject_id, v.id, v_previous, v_revoked;
END
$$;
