-- Final review of 0132: three low findings and one note.
--
-- L1. **A closed enrolment window does not block a bootstrap re-run.**
--     `core.open_bootstrap_enrolment_window` answered "a window is already open" for any approved
--     reset whose `enrolment_window_until` lay ahead, including one closed by its approver's
--     suspension (0132, F2: `closed_reason = 'approver_suspended'`) and one ended by a later
--     suspension or address change of the person (0128's barrier). Neither counts in
--     `core.mfa_reset_window_open`, so the first operator could be left with no window for up to
--     24 h. The re-run now asks the same question that function asks for resets.
--
-- L2. **An approval racing its approver's suspension does not stay open.**
--     `core.refuse_suspended_actor` read the actor's subject without a lock. A decision by D that
--     ran while D's suspension was uncommitted read "not suspended", then waited (its foreign-key
--     check takes `FOR KEY SHARE` on D) and committed after the suspension — whose closing UPDATEs
--     had not seen the still-pending row. The approval stayed in force. The guard now reads the
--     actor `FOR KEY SHARE`: the lock the same statement's foreign-key check already takes on
--     that row (every actor column references `core.subjects`), only taken before the check
--     instead of after the write. It waits for an uncommitted suspension and, under READ
--     COMMITTED, re-reads the committed row; when it locks first, the suspension's `FOR UPDATE`
--     of the person waits for the decision, and the closing UPDATEs then see it. No new lock is
--     taken, so the documented order (the person, then their requests) is unchanged.
--
-- L3. **The admin lists say why a request closed.** The application role may now read
--     `closed_reason` on email changes (0119 grants columns one by one); the API exposes it on
--     MFA resets, email changes, invitations, suspensions, role grants and role revocations.
--
-- N1. **A Google / Microsoft sign-in locks the person before the identity.** 0132's sign-in locked
--     the identity first and then, writing its login transaction and session, took `FOR KEY SHARE`
--     on the person — the reverse of a reset, an address change or a suspension, which lock the
--     person `FOR UPDATE` and then revoke the identity. Interleaved, the two deadlocked (40P01,
--     answered as a retryable 409). The sign-in now reads which person the identity belongs to,
--     takes `FOR KEY SHARE` on that person, and only then locks the identity: one order for all.
--
-- Decision table (docs/review-guidelines.md):
--
-- | Event | Identity namespace | Authority | Frozen | Live | Input scope | Priority |
-- | --- | --- | --- | --- | --- | --- | --- |
-- | Bootstrap re-run | the person, its tenant | the deploy runner | decided resets, closures | whether a counted reset window is open | the person's resets and barriers | a factor > creation window > counted reset window > open a new one |
-- | Decision racing the approver's suspension | the actor (subject id), the row's tenant | the database | committed decisions and closures | the actor's `suspended_at`, read under `FOR KEY SHARE` | one actor per column | suspension committed first refuses the decision; decision committed first is closed by the suspension |
-- | Admin list | request id, tenant | admin read | `closed_reason` as recorded | — | one tenant | `closed_reason` shown next to `state` |
-- | OIDC sign-in vs. revocation | the person, then the identity | the provider's token; the revoking decision | revoked identities | identity `revoked_at`, person `suspended_at` | one identity | whichever locks the person first; the other waits and re-reads |

SELECT set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- L3. The application role reads why an email change closed
-- ---------------------------------------------------------------------------

GRANT SELECT (closed_reason) ON core.email_change_requests TO mpc_app;

-- ---------------------------------------------------------------------------
-- L1. Bootstrap counts only the windows `mfa_reset_window_open` counts
-- ---------------------------------------------------------------------------

/** 0131's re-run; a reset window that no longer counts does not block a new one (L1). */
CREATE OR REPLACE FUNCTION core.open_bootstrap_enrolment_window(p_subject_id UUID)
RETURNS TABLE (opened BOOLEAN, reset_id UUID, window_until TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
SET row_security = off
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
  -- 0133 (L1): the reset branch of `core.mfa_reset_window_open` — not closed (0132, F2), and
  -- decided after the person's last suspension or completed address change (0128).
  SELECT r.id, r.enrolment_window_until INTO v_id, v_until
  FROM core.mfa_reset_requests r,
    LATERAL (
      SELECT GREATEST(
        (SELECT max(s.decided_at) FROM core.subject_suspensions s
         WHERE s.subject_id = p_subject_id AND s.action = 'suspend' AND s.state = 'approved'),
        (SELECT max(c.completed_at) FROM core.email_change_requests c
         WHERE c.subject_id = p_subject_id AND c.state = 'completed')
      ) AS at
    ) b
  WHERE r.subject_id = p_subject_id AND r.state = 'approved' AND r.enrolment_window_until > now()
    AND r.closed_reason IS NULL
    AND (b.at IS NULL OR r.decided_at > b.at)
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

-- ---------------------------------------------------------------------------
-- L2. The actor guard reads the actor under the lock its foreign key takes
-- ---------------------------------------------------------------------------

/** 0132's guard; the actor is read `FOR KEY SHARE`, so a racing suspension is seen (L2). */
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
    -- 0133 (L2): `FOR KEY SHARE` — the lock this statement's foreign-key check takes on the same
    -- row anyway — waits for a suspension of the actor still in progress and re-reads the
    -- committed row; a suspension that starts later waits for this transaction and then closes
    -- what it approved.
    SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v_actor FOR KEY SHARE;
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

-- ---------------------------------------------------------------------------
-- N1. Sign-in: the person, then the identity
-- ---------------------------------------------------------------------------

/** 0132's completion; the person is locked before the identity (N1). */
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
  v_subject_id UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  -- 0133 (N1): the person first. An identity's subject never changes, so reading it unlocked is
  -- enough to know which row to lock. `FOR KEY SHARE` is what the login transaction and the
  -- session take on the person below anyway; taken here, a revocation holding the person
  -- `FOR UPDATE` makes this wait before it holds the identity, and one that comes later waits for
  -- this sign-in instead of for an identity this sign-in holds.
  SELECT i.subject_id INTO v_subject_id FROM core.external_identities i
  WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
    AND i.revoked_at IS NULL;
  IF v_subject_id IS NOT NULL THEN
    PERFORM 1 FROM core.subjects s WHERE s.id = v_subject_id FOR KEY SHARE;
  END IF;

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

SELECT set_config('lock_timeout', '0', true);
