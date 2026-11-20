ALTER TABLE core.role_grant_requests
  DROP CONSTRAINT role_grant_two_person,
  DROP CONSTRAINT role_grant_not_self_target;

ALTER TABLE core.role_revocation_requests
  DROP CONSTRAINT role_revocation_two_person;

ALTER TABLE core.subject_suspensions
  DROP CONSTRAINT subject_suspensions_two_person;

ALTER TABLE core.break_glass_elevations
  DROP CONSTRAINT break_glass_two_person,
  DROP CONSTRAINT break_glass_release_two_person;

ALTER TABLE core.email_change_requests
  DROP CONSTRAINT email_change_two_person,
  DROP CONSTRAINT email_change_not_own_request,
  DROP CONSTRAINT email_change_not_own_decision;

CREATE OR REPLACE FUNCTION core.request_email_change(
  p_id UUID, p_subject_id UUID, p_new_email TEXT, p_reason TEXT, p_requested_by UUID
) RETURNS TABLE (status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET row_security = off
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_tenant UUID := core.current_tenant();
  v_email TEXT := core.normalize_email(p_new_email);
  v_current TEXT;
  v_suspended TIMESTAMPTZ;
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

  UPDATE core.email_change_requests SET state = 'expired', version = version + 1
  WHERE subject_id = p_subject_id AND state = 'approved' AND decided_at <= now() - interval '72 hours';

  SELECT s.email, s.suspended_at INTO v_current, v_suspended FROM core.subjects s
  WHERE s.id = p_subject_id FOR UPDATE;
  IF v_suspended IS NOT NULL THEN
    RETURN QUERY SELECT 'subject_suspended'::TEXT;
    RETURN;
  END IF;
  IF v_current IS NULL THEN
    RETURN QUERY SELECT 'no_address'::TEXT;
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

  IF p_approve THEN
    SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v.subject_id FOR UPDATE;
    IF v_suspended IS NOT NULL THEN
      RETURN QUERY SELECT 'subject_suspended'::TEXT, v.version, v.subject_id;
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
