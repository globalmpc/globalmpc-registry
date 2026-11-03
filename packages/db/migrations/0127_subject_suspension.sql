-- Suspending a person — account authentication plan journey 6, acceptance AUTH-06.
--
-- Until now a person could only lose their roles (role revocation, reason `offboarding`); they
-- could still sign in and hold sessions. A suspension takes the account out of use without
-- erasing it: every way in ends at once, and the history it signed stays as it was.
--
-- | Case | Identity namespace | Authority | Frozen vs live | Result |
-- | --- | --- | --- | --- | --- |
-- | Suspend | the subject, its tenant | two people with an admin role: proposer ≠ decider, neither is the subject | live: sessions, factors, identities, open challenges; frozen: signatures, attestations, decisions, audit, role bindings, wallets | `subjects.suspended_at` set; every live session, passkey, authenticator app, recovery code and linked identity revoked; open login, binding and passkey challenges removed; pending sign-in codes superseded; notice to the address |
-- | Sign-in while suspended | the address / `(iss, sub)` | — | — | refused exactly as an unknown address or identity: the start answers the same, no code is mailed, a code issued before is invalid, no session can be inserted, an existing one does not resolve |
-- | Reinstate | same | same two-person rule, plus the recovery separation of 0118 | — | `suspended_at` cleared; a 24-hour first-enrolment window opens (factors were revoked); notice to the address |
-- | A second request while one is pending | the subject | — | — | refused (`subject_suspensions_one_pending`) |
--
-- Status priority: suspension is checked before anything else a sign-in looks at. A reinstated
-- person signs in by email code and enrols new factors; Google / Microsoft must be linked again.
--
-- Reinstating opens an enrolment window, as an MFA reset does, so it joins 0118's separation:
-- someone who took part in a recent email change of the person cannot propose or approve their
-- reinstatement, and someone who took part in a recent reinstatement cannot take part in an email
-- change. Suspending only takes access away and, like a rejection, is never refused for it.
--
-- The application role proposes (a plain insert of the proposal's columns) and reads; only
-- `core.decide_subject_suspension` decides, and only it writes `subjects.suspended_at`.

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

ALTER TABLE core.subjects
  ADD COLUMN suspended_at TIMESTAMPTZ;
-- No grant: 0112 granted the application role its subject columns one by one, so this one is
-- written only by the decision function below.

CREATE TYPE core.subject_suspension_action AS ENUM ('suspend', 'reinstate');

CREATE TABLE core.subject_suspensions (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants (id),
  subject_id              UUID NOT NULL,
  action                  core.subject_suspension_action NOT NULL,
  reason                  TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  requested_by_subject_id UUID NOT NULL,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                   core.mfa_reset_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id   UUID,
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 1 AND 2000),
  -- Reinstatement only: until when an aal1 session of the subject may enrol a first factor.
  enrolment_window_until  TIMESTAMPTZ,
  version                 INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT subject_suspensions_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT subject_suspensions_requester_same_tenant
    FOREIGN KEY (tenant_id, requested_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT subject_suspensions_decider_same_tenant
    FOREIGN KEY (tenant_id, decided_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  -- Two people, and neither is the person: suspending oneself is not a use case, and reinstating
  -- oneself would be a one-person way back in.
  CONSTRAINT subject_suspensions_two_person CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> requested_by_subject_id
  ),
  CONSTRAINT subject_suspensions_not_self CHECK (
    requested_by_subject_id <> subject_id
    AND (decided_by_subject_id IS NULL OR decided_by_subject_id <> subject_id)
  ),
  CONSTRAINT subject_suspensions_decision_shape CHECK (
    (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL
      AND enrolment_window_until IS NULL)
    OR (state = 'rejected' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND enrolment_window_until IS NULL)
    OR (state = 'approved' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND (enrolment_window_until = decided_at + interval '24 hours') = (action = 'reinstate')
      AND (enrolment_window_until IS NULL) = (action = 'suspend'))
  )
);

CREATE UNIQUE INDEX subject_suspensions_one_pending ON core.subject_suspensions (subject_id)
  WHERE state = 'pending';
CREATE INDEX subject_suspensions_tenant_idx ON core.subject_suspensions (tenant_id, requested_at DESC);

ALTER TABLE core.subject_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.subject_suspensions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.subject_suspensions
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

REVOKE ALL ON core.subject_suspensions FROM mpc_app;
GRANT SELECT ON core.subject_suspensions TO mpc_app;
-- State, decision, window and version keep their defaults (pending, none, none, 1).
GRANT INSERT (id, tenant_id, subject_id, action, reason, requested_by_subject_id)
  ON core.subject_suspensions TO mpc_app;

ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_template_check;
ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_template_check CHECK (template IN (
  'sign_in_code', 'invitation_link', 'invitation_code',
  'email_change_code', 'email_changed_notice', 'mfa_reset_notice',
  'account_suspended_notice', 'account_reinstated_notice'
));

-- ---------------------------------------------------------------------------
-- 2. Recovery separation (0118) with reinstatement
-- ---------------------------------------------------------------------------

/**
 * 0118's rule. The `email_change` side now also counts a reinstatement the actor proposed or
 * decided (pending or approved, 30 days): a reinstatement opens an enrolment window like an MFA
 * reset. Reinstatements are checked from the `mfa_reset` side (recent email changes).
 */
CREATE OR REPLACE FUNCTION core.recovery_separation_conflict(p_subject_id UUID, p_actor UUID, p_side TEXT)
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
    ) OR EXISTS (
      SELECT 1 FROM core.subject_suspensions r
      WHERE r.subject_id = p_subject_id
        AND r.action = 'reinstate'
        AND r.state IN ('pending', 'approved')
        AND p_actor IN (r.requested_by_subject_id, r.decided_by_subject_id)
        AND GREATEST(r.requested_at, r.decided_at) > now() - interval '30 days'
    );
  END IF;
  RAISE EXCEPTION 'unknown recovery side %', p_side USING ERRCODE = 'invalid_parameter_value';
END
$$;

/**
 * A proposal is a plain insert, so its rules are a trigger: suspend only an active person,
 * reinstate only a suspended one, and a reinstatement keeps 0118's separation. Locks the subject
 * so a decision or an email-change check running at the same time is seen.
 */
CREATE FUNCTION core.subject_suspension_proposal_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_subject core.subjects;
BEGIN
  SELECT * INTO v_subject FROM core.subjects
  WHERE id = NEW.subject_id AND tenant_id = NEW.tenant_id
  FOR UPDATE;
  IF NOT FOUND OR v_subject.kind <> 'person' THEN
    RAISE EXCEPTION 'SUSPENSION_NOT_A_PERSON: only a person is suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'suspend' AND v_subject.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person is already suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'reinstate' AND v_subject.suspended_at IS NULL THEN
    RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person is not suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'reinstate'
     AND core.recovery_separation_conflict(NEW.subject_id, NEW.requested_by_subject_id, 'mfa_reset') THEN
    RAISE EXCEPTION 'SUSPENSION_SEPARATION_REQUIRED: the proposer took part in a recent email change of this person'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION core.subject_suspension_proposal_guard() FROM PUBLIC;

CREATE TRIGGER subject_suspensions_proposal
  BEFORE INSERT ON core.subject_suspensions
  FOR EACH ROW EXECUTE FUNCTION core.subject_suspension_proposal_guard();

-- ---------------------------------------------------------------------------
-- 3. Decision
-- ---------------------------------------------------------------------------

/**
 * Approves or rejects a suspension or reinstatement. Approval acts in the same transaction:
 *
 * - suspend: marks the subject, revokes every live session, passkey, authenticator app,
 *   recovery code and linked identity (`suspension`), removes open login, binding and passkey
 *   challenges, supersedes pending sign-in codes and queues `account_suspended_notice`;
 * - reinstate: clears the mark, opens a 24-hour enrolment window and queues
 *   `account_reinstated_notice`.
 *
 * Signatures, attestations, decisions, role bindings, wallets and the audit trail are not touched.
 */
CREATE FUNCTION core.decide_subject_suspension(
  p_request_id UUID,
  p_decider UUID,
  p_approve BOOLEAN,
  p_reason TEXT,
  p_expected_version INTEGER
) RETURNS TABLE (
  revoked_sessions       INTEGER,
  revoked_authenticators INTEGER,
  revoked_identities     INTEGER,
  new_version            INTEGER
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

  -- Subject before sessions (0118 L1).
  SELECT * INTO v_subject FROM core.subjects
  WHERE id = v_request.subject_id AND tenant_id = v_request.tenant_id
  FOR UPDATE;

  IF p_approve THEN
    IF (v_request.action = 'suspend') <> (v_subject.suspended_at IS NULL) THEN
      RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person''s state changed since the proposal'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_request.action = 'reinstate'
       AND (core.recovery_separation_conflict(v_request.subject_id, p_decider, 'mfa_reset')
         OR core.recovery_separation_conflict(v_request.subject_id, v_request.requested_by_subject_id, 'mfa_reset')) THEN
      RAISE EXCEPTION 'SUSPENSION_SEPARATION_REQUIRED: the proposer or decider took part in a recent email change of this person'
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

    -- Open ceremonies of the person's sessions: nothing half-done completes after this.
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

  RETURN QUERY SELECT v_sessions, v_authenticators, COALESCE(array_length(v_removed, 1), 0), v_request.version + 1;
END
$$;

REVOKE EXECUTE ON FUNCTION core.decide_subject_suspension(UUID, UUID, BOOLEAN, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.decide_subject_suspension(UUID, UUID, BOOLEAN, TEXT, INTEGER) TO mpc_app;

-- ---------------------------------------------------------------------------
-- 4. A suspended person has no way in
-- ---------------------------------------------------------------------------

/** 0112's lookup, minus a suspended person: the sign-in start then answers as for an unknown address. */
CREATE OR REPLACE FUNCTION core.find_person_by_email(p_email TEXT)
RETURNS TABLE (subject_id UUID, tenant_id UUID)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT s.id, s.tenant_id
  FROM core.subjects s
  WHERE s.email = core.normalize_email(p_email) AND s.kind = 'person' AND s.suspended_at IS NULL
$$;

/**
 * 0114's check with one more condition: a right code for a suspended person is `code_invalid`,
 * the answer a wrong code gets (a code issued before the suspension was superseded by it anyway).
 */
CREATE OR REPLACE FUNCTION core.verify_sign_in_code(
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
      AND s.suspended_at IS NULL
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

/**
 * The last line, for every role that can write `core.sessions`: no session is created for a
 * suspended person, whichever function or path tries.
 */
CREATE FUNCTION core.sessions_refuse_suspended() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NEW.subject_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM core.subjects s WHERE s.id = NEW.subject_id AND s.suspended_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_SUSPENDED: no session for a suspended person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION core.sessions_refuse_suspended() FROM PUBLIC;

CREATE TRIGGER sessions_a_refuse_suspended
  BEFORE INSERT ON core.sessions
  FOR EACH ROW EXECUTE FUNCTION core.sessions_refuse_suspended();

/** 0125's resolver, plus: a suspended person's session does not resolve (status priority 1). */
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
  RETURNING
    s.id, s.subject_id, s.tenant_id, s.first_factor, s.second_factor, s.second_factor_at,
    s.recovery_limited,
    (SELECT subject.assurance_level FROM core.subjects subject WHERE subject.id = s.subject_id),
    s.expires_at
$$;

-- ---------------------------------------------------------------------------
-- 5. Reinstatement opens the first-enrolment window
-- ---------------------------------------------------------------------------

/** 0116's window, plus an approved reinstatement's 24 hours. */
CREATE OR REPLACE FUNCTION core.mfa_reset_window_open(p_subject_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.mfa_reset_requests
    WHERE subject_id = p_subject_id AND state = 'approved' AND enrolment_window_until > now()
  ) OR EXISTS (
    SELECT 1 FROM core.subject_suspensions
    WHERE subject_id = p_subject_id AND action = 'reinstate' AND state = 'approved'
      AND enrolment_window_until > now()
  )
$$;

-- ---------------------------------------------------------------------------
-- 6. Google / Microsoft sign-in answers a suspended person as an unknown identity
-- ---------------------------------------------------------------------------

/**
 * 0121's completion, plus: an identity of a suspended person is `not_found`, the answer for an
 * identity nobody linked. Suspension revokes the identities anyway; this holds even for one
 * linked by some other path afterwards, and keeps the session trigger from turning it into a 500.
 */
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
AS $$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'sign_in');
  v_identity core.external_identities;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_identity FROM core.external_identities i
  WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
    AND i.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM core.subjects s WHERE s.id = i.subject_id AND s.suspended_at IS NOT NULL
    );
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
