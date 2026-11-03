-- Suspension closes what is still open — security review of 0127 (S-M1, S-L1, S-L2).
--
-- S-M1. An email change approved before a suspension could still be completed while the person
-- was suspended: two admins approve a change to an address they read, two admins suspend the
-- person (suspension was outside 0118's separation), the code from the new address completes the
-- change, and a reinstatement by two other admins then opens a 24-hour enrolment window for
-- whoever reads that address. Now:
--
-- 1. Approving a suspension closes, in the same transaction, the person's pending and approved
--    email changes (`expired`) and pending MFA resets (`rejected`), with
--    `closed_reason = 'subject_suspended'`; an MFA reset's open window ends with the suspension
--    (`mfa_reset_window_open`, below). The API audits every closed request.
-- 2. While the person is suspended, an email change cannot be proposed or approved
--    (`subject_suspended`) and an approved one cannot be completed — the public verify answers
--    `code_invalid`, the answer for any wrong code; an MFA reset cannot be proposed or approved
--    (`MFA_RESET_SUBJECT_SUSPENDED`).
-- 3. 0118's separation now has three sides. Whoever took part (proposed or decided, pending or
--    approved, 30 days) in one of an email change, an admin MFA reset or a suspension /
--    reinstatement of a person takes no part in the other two for that person; a request a
--    suspension closed still counts. Rejections are never refused.
--
-- Also closed here: an enrolment window (MFA reset or reinstatement) opened before the person's
-- address last changed no longer admits enrolment. Without this, two admins could change the
-- address of a person whose reset an honest pair had just approved, and the new address would
-- enrol inside that window.
--
-- S-L1. A suspended admin's proposals stayed open and could be decided by another admin. Approving
-- a suspension now closes every pending two-person request the person proposed — role grants and
-- revocations (`withdrawn`), MFA resets, suspensions, registry proposals, registry publication
-- drafts and break-glass elevations (`rejected`), and email changes (`expired`, approved ones
-- too) — with `closed_reason = 'proposer_suspended'`. And no suspended subject can propose or
-- decide any of them: a trigger on each table refuses the row (`ACTOR_SUSPENDED`). A suspended
-- subject has no session, so this is defence in depth.
--
-- | Case | Identity namespace | Authority | Frozen vs live | Status priority | Result |
-- | --- | --- | --- | --- | --- | --- |
-- | Suspension approved | the person, its tenant | two admins outside the separation | live: the person's open recovery requests and the requests they proposed; frozen: decided and completed requests, audit | suspension before any open request | open requests closed with a `closed_reason`; each audited |
-- | Email change / MFA reset of a suspended person | same | — | — | suspended before every other check except not-found and self | propose / approve refused; email-change verify answers `code_invalid` |
-- | A suspended subject as proposer or decider | the actor | — | — | before the row is written | `ACTOR_SUSPENDED` |
-- | Enrolment window opened before the latest suspension or completed email change | the person | — | the window row is kept | the later event wins | no enrolment through that window |
--
-- `closed_reason` is written only by `core.decide_subject_suspension`: the application role gets
-- no UPDATE on it (column-level grants below) and a trigger refuses it on INSERT.

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. `closed_reason` on every two-person request table
-- ---------------------------------------------------------------------------

ALTER TABLE core.email_change_requests ADD COLUMN closed_reason TEXT;
ALTER TABLE core.mfa_reset_requests ADD COLUMN closed_reason TEXT;
ALTER TABLE core.subject_suspensions ADD COLUMN closed_reason TEXT;
ALTER TABLE core.role_grant_requests ADD COLUMN closed_reason TEXT;
ALTER TABLE core.role_revocation_requests ADD COLUMN closed_reason TEXT;
ALTER TABLE core.registry_proposals ADD COLUMN closed_reason TEXT;
ALTER TABLE core.registry_publication_drafts ADD COLUMN closed_reason TEXT;
ALTER TABLE core.break_glass_elevations ADD COLUMN closed_reason TEXT;

-- A closed row is the terminal state each table already has for "ended without a decision",
-- with no decider. Tables whose decision shape required a decider for that state accept the
-- closed row instead (`closed_reason IS NOT NULL OR <shape as before>`).
ALTER TABLE core.email_change_requests ADD CONSTRAINT email_change_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason IN ('subject_suspended', 'proposer_suspended') AND state = 'expired')
);

ALTER TABLE core.role_grant_requests ADD CONSTRAINT role_grant_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason = 'proposer_suspended' AND state = 'withdrawn' AND decided_by_subject_id IS NULL)
);

ALTER TABLE core.role_revocation_requests ADD CONSTRAINT role_revocation_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason = 'proposer_suspended' AND state = 'withdrawn' AND decided_by_subject_id IS NULL)
);

ALTER TABLE core.mfa_reset_requests DROP CONSTRAINT mfa_reset_decision_shape;
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_decision_shape CHECK (
  closed_reason IS NOT NULL
  OR (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL
    AND enrolment_window_until IS NULL)
  OR (state = 'rejected' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND enrolment_window_until IS NULL)
  OR (state = 'approved' AND decided_at IS NOT NULL
    AND enrolment_window_until = decided_at + interval '24 hours'
    AND (decided_by_subject_id IS NOT NULL) = (origin = 'admin'))
);
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason IN ('subject_suspended', 'proposer_suspended') AND state = 'rejected'
    AND decided_by_subject_id IS NULL AND decided_at IS NOT NULL AND enrolment_window_until IS NULL)
);

ALTER TABLE core.subject_suspensions DROP CONSTRAINT subject_suspensions_decision_shape;
ALTER TABLE core.subject_suspensions ADD CONSTRAINT subject_suspensions_decision_shape CHECK (
  closed_reason IS NOT NULL
  OR (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL
    AND enrolment_window_until IS NULL)
  OR (state = 'rejected' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND enrolment_window_until IS NULL)
  OR (state = 'approved' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND (enrolment_window_until = decided_at + interval '24 hours') = (action = 'reinstate')
    AND (enrolment_window_until IS NULL) = (action = 'suspend'))
);
ALTER TABLE core.subject_suspensions ADD CONSTRAINT subject_suspensions_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason = 'proposer_suspended' AND state = 'rejected'
    AND decided_by_subject_id IS NULL AND decided_at IS NOT NULL AND enrolment_window_until IS NULL)
);

ALTER TABLE core.registry_proposals DROP CONSTRAINT registry_proposal_decision_shape;
ALTER TABLE core.registry_proposals ADD CONSTRAINT registry_proposal_decision_shape CHECK (
  closed_reason IS NOT NULL
  OR (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL
    AND decision_reason IS NULL AND materialized_id IS NULL)
  OR (state = 'rejected' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0 AND materialized_id IS NULL)
  OR (state = 'approved' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0 AND materialized_id IS NOT NULL)
);
ALTER TABLE core.registry_proposals ADD CONSTRAINT registry_proposal_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason = 'proposer_suspended' AND state = 'rejected'
    AND decided_by_subject_id IS NULL AND decided_at IS NOT NULL AND materialized_id IS NULL)
);

ALTER TABLE core.registry_publication_drafts DROP CONSTRAINT registry_draft_decision_shape;
ALTER TABLE core.registry_publication_drafts ADD CONSTRAINT registry_draft_decision_shape CHECK (
  closed_reason IS NOT NULL
  OR (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL
    AND decision_reason IS NULL AND entry_version_id IS NULL AND NOT person_identifier_publication_approved)
  OR (state = 'rejected' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0 AND entry_version_id IS NULL)
  OR (state = 'published' AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND entry_version_id IS NOT NULL)
);
ALTER TABLE core.registry_publication_drafts ADD CONSTRAINT registry_draft_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason = 'proposer_suspended' AND state = 'rejected'
    AND decided_by_subject_id IS NULL AND decided_at IS NOT NULL AND entry_version_id IS NULL)
);

ALTER TABLE core.break_glass_elevations DROP CONSTRAINT break_glass_decision_shape;
ALTER TABLE core.break_glass_elevations ADD CONSTRAINT break_glass_decision_shape CHECK (
  closed_reason IS NOT NULL
  OR (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL)
  OR (state IN ('active', 'rejected', 'released')
    AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
    AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0)
);
ALTER TABLE core.break_glass_elevations ADD CONSTRAINT break_glass_closed_shape CHECK (
  closed_reason IS NULL
  OR (closed_reason = 'proposer_suspended' AND state = 'rejected'
    AND decided_by_subject_id IS NULL AND decided_at IS NOT NULL)
);

/**
 * The application role updates five of these tables itself. Its table-wide UPDATE would cover the
 * new column, so it becomes UPDATE on every column but `closed_reason`. (The other three tables
 * it cannot update at all.)
 */
DO $$
DECLARE
  t TEXT;
  cols TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'role_grant_requests', 'role_revocation_requests', 'registry_proposals',
    'registry_publication_drafts', 'break_glass_elevations'
  ] LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a
    WHERE a.attrelid = ('core.' || t)::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname <> 'closed_reason';
    EXECUTE format('REVOKE UPDATE ON core.%I FROM mpc_app', t);
    EXECUTE format('GRANT UPDATE (%s) ON core.%I TO mpc_app', cols, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. No suspended subject proposes or decides
-- ---------------------------------------------------------------------------

/**
 * Refuses a row whose proposer (on INSERT) or a newly set actor column (on UPDATE) is a suspended
 * subject, and a `closed_reason` on INSERT. `TG_ARGV` names the actor columns of the table, the
 * proposer first. A subject only `decide_subject_suspension` can close requests for.
 */
CREATE FUNCTION core.refuse_suspended_actor() RETURNS TRIGGER
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
BEGIN
  IF TG_OP = 'INSERT' AND NEW.closed_reason IS NOT NULL THEN
    RAISE EXCEPTION 'REQUEST_CLOSED_REASON_RESERVED: only a suspension closes a request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    v_actor := (v_new ->> v_column)::UUID;
    CONTINUE WHEN v_actor IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND v_actor IS NOT DISTINCT FROM (v_old ->> v_column)::UUID;
    IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.id = v_actor AND s.suspended_at IS NOT NULL) THEN
      RAISE EXCEPTION 'ACTOR_SUSPENDED: a suspended account takes part in no decision'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION core.refuse_suspended_actor() FROM PUBLIC;

CREATE TRIGGER email_change_requests_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.email_change_requests
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('requested_by_subject_id', 'decided_by_subject_id');
CREATE TRIGGER mfa_reset_requests_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.mfa_reset_requests
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('requested_by_subject_id', 'decided_by_subject_id');
CREATE TRIGGER subject_suspensions_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.subject_suspensions
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('requested_by_subject_id', 'decided_by_subject_id');
CREATE TRIGGER role_grant_requests_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.role_grant_requests
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('requested_by_subject_id', 'decided_by_subject_id');
CREATE TRIGGER role_revocation_requests_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.role_revocation_requests
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('requested_by_subject_id', 'decided_by_subject_id');
CREATE TRIGGER registry_proposals_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.registry_proposals
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('proposed_by_subject_id', 'decided_by_subject_id');
CREATE TRIGGER registry_publication_drafts_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.registry_publication_drafts
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor('proposed_by_subject_id', 'decided_by_subject_id');
CREATE TRIGGER break_glass_elevations_actor_not_suspended
  BEFORE INSERT OR UPDATE ON core.break_glass_elevations
  FOR EACH ROW EXECUTE FUNCTION core.refuse_suspended_actor(
    'subject_id', 'decided_by_subject_id', 'incident_recorded_by_subject_id', 'released_by_subject_id'
  );

-- ---------------------------------------------------------------------------
-- 3. Separation with three sides (0118, 0127)
-- ---------------------------------------------------------------------------
-- A request a suspension closed (`closed_reason` set) still counts: nobody judged it wrong, so the
-- part its proposer and decider took in it stands. Only a human rejection or a natural expiry
-- clears it, as in 0118.

/** Whether `p_actor` proposed or decided an email change of the person (pending, approved or completed, 30 days). */
CREATE FUNCTION core.recent_email_change_part(p_subject_id UUID, p_actor UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.email_change_requests c
    WHERE c.subject_id = p_subject_id
      AND (c.state IN ('pending', 'approved', 'completed') OR c.closed_reason IS NOT NULL)
      AND p_actor IN (c.requested_by_subject_id, c.decided_by_subject_id)
      AND GREATEST(c.requested_at, c.decided_at, c.completed_at) > now() - interval '30 days'
  )
$$;

/** Whether `p_actor` proposed or decided an admin MFA reset of the person (pending or approved, 30 days). */
CREATE FUNCTION core.recent_mfa_reset_part(p_subject_id UUID, p_actor UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.mfa_reset_requests r
    WHERE r.subject_id = p_subject_id
      AND r.origin = 'admin'
      AND (r.state IN ('pending', 'approved') OR r.closed_reason IS NOT NULL)
      AND p_actor IN (r.requested_by_subject_id, r.decided_by_subject_id)
      AND GREATEST(r.requested_at, r.decided_at) > now() - interval '30 days'
  )
$$;

/** Whether `p_actor` proposed or decided a suspension or reinstatement of the person (pending or approved, 30 days). */
CREATE FUNCTION core.recent_suspension_part(p_subject_id UUID, p_actor UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.subject_suspensions r
    WHERE r.subject_id = p_subject_id
      AND (r.state IN ('pending', 'approved') OR r.closed_reason IS NOT NULL)
      AND p_actor IN (r.requested_by_subject_id, r.decided_by_subject_id)
      AND GREATEST(r.requested_at, r.decided_at) > now() - interval '30 days'
  )
$$;

REVOKE EXECUTE ON FUNCTION core.recent_email_change_part(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.recent_mfa_reset_part(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.recent_suspension_part(UUID, UUID) FROM PUBLIC;

/**
 * 0118's rule over three flows. `p_side` is the flow being proposed or decided now; the actor
 * conflicts when they took part in either of the other two for the same person.
 */
CREATE OR REPLACE FUNCTION core.recovery_separation_conflict(p_subject_id UUID, p_actor UUID, p_side TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = core, pg_temp
AS $$
BEGIN
  IF p_side = 'mfa_reset' THEN
    RETURN core.recent_email_change_part(p_subject_id, p_actor)
        OR core.recent_suspension_part(p_subject_id, p_actor);
  ELSIF p_side = 'email_change' THEN
    RETURN core.recent_mfa_reset_part(p_subject_id, p_actor)
        OR core.recent_suspension_part(p_subject_id, p_actor);
  ELSIF p_side = 'suspension' THEN
    RETURN core.recent_email_change_part(p_subject_id, p_actor)
        OR core.recent_mfa_reset_part(p_subject_id, p_actor);
  END IF;
  RAISE EXCEPTION 'unknown recovery side %', p_side USING ERRCODE = 'invalid_parameter_value';
END
$$;

/** 0127's proposal rules, with the separation for both actions (`suspension` side). */
CREATE OR REPLACE FUNCTION core.subject_suspension_proposal_guard() RETURNS TRIGGER
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
  IF core.recovery_separation_conflict(NEW.subject_id, NEW.requested_by_subject_id, 'suspension') THEN
    RAISE EXCEPTION 'SUSPENSION_SEPARATION_REQUIRED: the proposer took part in a recent email change or MFA reset of this person'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Enrolment windows end with a suspension or an address change
-- ---------------------------------------------------------------------------

/**
 * 0127's window (an approved MFA reset or reinstatement, 24 hours), counting only a window opened
 * after the person's latest approved suspension and latest completed email change. A suspension
 * ends a reset's window; an address change ends any window, so a new address never enrols
 * through a window opened for the old one.
 */
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
      AND (b.at IS NULL OR r.decided_at > b.at)
  ) OR EXISTS (
    SELECT 1 FROM core.subject_suspensions r, barrier b
    WHERE r.subject_id = p_subject_id AND r.action = 'reinstate' AND r.state = 'approved'
      AND r.enrolment_window_until > now()
      AND (b.at IS NULL OR r.decided_at > b.at)
  )
$$;

-- ---------------------------------------------------------------------------
-- 5. Email change and MFA reset refuse a suspended person
-- ---------------------------------------------------------------------------

/** 0118's proposal, plus `subject_suspended`. The separation rule is now three-sided (above). */
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
  IF p_subject_id = p_requested_by THEN
    RETURN QUERY SELECT 'self'::TEXT;
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

/** 0118's decision, plus `subject_suspended` on approval. A rejection is never refused. */
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
  v_suspended TIMESTAMPTZ;
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

/**
 * 0123's completion, plus: a suspended person's address does not change. Answered `code_invalid`,
 * the answer for any wrong code, so the public route says nothing about the account.
 */
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
  v_suspended TIMESTAMPTZ;
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

/**
 * 0118's proposal guard for MFA resets, plus: no reset of a suspended person, from any origin (a
 * bootstrap re-run included — it would open a window). The separation is three-sided (above).
 */
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

/** 0123's decision, plus: approval is refused while the person is suspended. */
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
  v_suspended TIMESTAMPTZ;
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

  RETURN QUERY SELECT v_sessions, v_authenticators, v_codes, v_request.version + 1;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. The suspension decision closes what is open
-- ---------------------------------------------------------------------------

DROP FUNCTION core.decide_subject_suspension(UUID, UUID, BOOLEAN, TEXT, INTEGER);

/**
 * 0127's decision, plus: the separation for both actions, and on an approved suspension every
 * open request the person is the subject of (email changes, MFA resets) or proposed (every
 * two-person table) is closed with a `closed_reason`. `closed_requests` lists them —
 * `[{"kind", "id", "reason"}]`, and `"window_closed"` for an approved reset whose window the
 * suspension ended — for the API to audit.
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

REVOKE EXECUTE ON FUNCTION core.decide_subject_suspension(UUID, UUID, BOOLEAN, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.decide_subject_suspension(UUID, UUID, BOOLEAN, TEXT, INTEGER) TO mpc_app;

SELECT set_config('lock_timeout', '0', true);
