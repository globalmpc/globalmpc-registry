-- The exception preserves only the person's existing assurance, only during
-- consumption of a confirmed self-approved recovery. Each new key is proof-bound.
CREATE FUNCTION core.wallet_recovery_self_approval_valid(p_holder uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog,core,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id AND s.tenant_id=b.tenant_id
    WHERE b.tenant_id=core.current_tenant() AND b.subject_id=p_holder
      AND b.role='administrator' AND b.revoked_at IS NULL AND b.project_id IS NULL
      AND coalesce(b.scope_kind,'tenant')='tenant' AND b.jurisdiction IS NULL
      AND s.kind='person' AND s.suspended_at IS NULL AND s.assurance_level >= 'high_assurance'
  ) AND NOT core.has_other_wallet_recovery_admin(p_holder)
$$;
REVOKE ALL ON FUNCTION core.wallet_recovery_self_approval_valid(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.wallet_recovery_self_approval_valid(uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.approve_wallet_recovery(p_session uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,core,pg_temp AS $$
DECLARE actor core.sessions := core.mfa_lock_session(p_session);
BEGIN
  IF actor.recovery_limited OR NOT EXISTS (SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id
    WHERE b.tenant_id=actor.tenant_id AND b.subject_id=actor.subject_id AND b.role='administrator' AND b.revoked_at IS NULL
      AND b.project_id IS NULL AND coalesce(b.scope_kind,'tenant')='tenant' AND b.jurisdiction IS NULL
      AND s.kind='person' AND s.suspended_at IS NULL AND s.assurance_level >= 'high_assurance') THEN RETURN false; END IF;
  UPDATE core.wallet_recoveries SET approved_by=actor.subject_id, approved_at=now() WHERE id=p_id AND tenant_id=actor.tenant_id
    AND cancelled_at IS NULL AND consumed_at IS NULL AND (approved_by IS NULL OR (approved_by=subject_id AND subject_id<>actor.subject_id)) AND confirmed_at IS NOT NULL
    AND (subject_id <> actor.subject_id OR NOT core.has_other_wallet_recovery_admin(actor.subject_id))
    AND created_at>now()-interval '24 hours' AND core.wallet_recovery_session_live(p_id);
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION core.bind_wallet_by_proof(
  p_session_id UUID,
  p_challenge_id UUID,
  p_signer TEXT,
  p_wallet_id UUID,
  p_replace_cause TEXT,
  p_previous_signer TEXT
) RETURNS TABLE (
  wallet_id UUID, wallet_address TEXT, chain_id INTEGER,
  previous_assurance core.assurance_level, assurance core.assurance_level,
  replaced_wallet_id UUID, replaced_wallet_address TEXT, replaced_chain_id INTEGER,
  replaced_bound_via TEXT, rebind_of UUID, rebind_same_subject BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
-- The re-bind history is read in every tenant. An owner without BYPASSRLS would see only the
-- current tenant's rows under FORCE RLS and quietly narrow the check; with row security off, it
-- fails loudly instead ("query would be affected by row-level security policy").
SET row_security = off
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge core.wallet_binding_challenges;
  v_active core.wallet_identities;
  v_last core.wallet_identities;
  v_rebind core.wallet_identities;
  v_before core.assurance_level;
  v_after core.assurance_level;
  v_self_recovery boolean := false;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, true);

  IF p_replace_cause IS NULL OR p_replace_cause NOT IN ('rotation', 'key_lost', 'key_compromised') THEN
    RAISE EXCEPTION 'WALLET_REASON_INVALID: not a reason a person gives for replacing a wallet'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_challenge FROM core.wallet_binding_challenges c
  WHERE c.id = p_challenge_id AND c.session_id = v.id AND c.tenant_id = v.tenant_id
    AND c.subject_id = v.subject_id AND c.consumed_at IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR v_challenge.wallet_address <> lower(p_signer) THEN
    RAISE EXCEPTION 'WALLET_CHALLENGE_INVALID: no live binding challenge of this session matches'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_active FROM core.wallet_identities w
  WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL
  FOR UPDATE;
  -- The screen showed what this binding replaces; if that changed, the person did not agree.
  IF v_active.id IS DISTINCT FROM v_challenge.replaces_wallet_id THEN
    RAISE EXCEPTION 'WALLET_CHALLENGE_INVALID: the account''s wallet changed since this challenge'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_active.id IS NOT NULL AND v_active.wallet_address = v_challenge.wallet_address
     AND v_active.chain_id = v_challenge.chain_id THEN
    RAISE EXCEPTION 'WALLET_ALREADY_ACTIVE: this wallet already is the account''s signing wallet'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- History of this address in every tenant: a key moves between accounts, not between tenants'
  -- views of it. Every comparison is NULL-safe and an unknown answers "refuse":
  --   * compromised (directly, or as the cause of a replace): never again, not even the same person;
  --   * disabled by an admin (decider is not the wallet's subject, a NULL subject included): never;
  --   * lost (directly or as a replace cause), consolidated by 0130, or disabled with no recorded
  --     event: only the subject that held it — someone else may have found the key;
  --   * rotation and offboarding by the holder: anyone who proves the key.
  -- One refusal code, so the answer does not say why.
  IF EXISTS (
    SELECT 1 FROM core.wallet_identities w
    LEFT JOIN core.wallet_disable_events e ON e.wallet_identity_id = w.id
    WHERE w.wallet_address = v_challenge.wallet_address AND w.chain_id = v_challenge.chain_id
      AND w.disabled_at IS NOT NULL
      AND (
        e.reason_code IS NOT DISTINCT FROM 'key_compromised'
        OR e.replace_cause IS NOT DISTINCT FROM 'key_compromised'
        OR (e.id IS NOT NULL
            AND e.reason_code IS DISTINCT FROM 'consolidated_single_wallet'
            AND e.disabled_by_subject_id IS DISTINCT FROM w.subject_id)
        OR ((e.id IS NULL
             OR e.reason_code IS NOT DISTINCT FROM 'key_lost'
             OR e.replace_cause IS NOT DISTINCT FROM 'key_lost'
             OR e.reason_code IS NOT DISTINCT FROM 'consolidated_single_wallet')
            AND w.subject_id IS DISTINCT FROM v.subject_id)
      )
  ) THEN
    RAISE EXCEPTION 'WALLET_UNAVAILABLE: this wallet cannot be bound'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_active.id IS NULL THEN
    SELECT * INTO v_last FROM core.wallet_identities w
    WHERE w.tenant_id = v.tenant_id AND w.subject_id = v.subject_id
    ORDER BY w.disabled_at DESC, w.created_at DESC, w.id DESC LIMIT 1;
  END IF;
  -- A holder can restore their most recent key with a fresh signature. A new
  -- key cannot bootstrap a replacement by disabling the existing key first.
  IF (v_active.id IS NOT NULL AND v_active.wallet_address IS DISTINCT FROM lower(p_previous_signer))
     OR (v_last.id IS NOT NULL AND (
       v_last.wallet_address IS DISTINCT FROM lower(p_signer) OR v_last.chain_id <> v_challenge.chain_id
       OR NOT EXISTS (SELECT 1 FROM core.wallet_disable_events e
         WHERE e.wallet_identity_id = v_last.id AND e.disabled_by_subject_id = v.subject_id
           AND e.reason_code IN ('rotation', 'key_lost', 'offboarding'))
       OR EXISTS (SELECT 1 FROM core.wallet_identities w WHERE w.wallet_address = v_last.wallet_address
         AND w.chain_id = v_last.chain_id AND w.id <> v_last.id AND w.created_at >= v_last.disabled_at)
     )) THEN
    UPDATE core.wallet_recoveries r SET consumed_at=now() FROM core.subjects owner
    WHERE r.session_id=v.id AND r.subject_id=v.subject_id AND r.tenant_id=v.tenant_id AND owner.id=r.subject_id
      AND owner.email=r.email AND owner.suspended_at IS NULL AND r.wallet_address=v_challenge.wallet_address
      AND r.chain_id=v_challenge.chain_id AND r.previous_wallet_id=coalesce(v_active.id,v_last.id)
      AND r.previous_version=coalesce(v_active.version,v_last.version) AND r.confirmed_at IS NOT NULL
      AND r.approved_at <= v_challenge.created_at AND r.approved_by IS NOT NULL AND r.consumed_at IS NULL AND r.cancelled_at IS NULL
      AND r.created_at>now()-interval '24 hours'
      AND (r.approved_by <> r.subject_id OR core.wallet_recovery_self_approval_valid(r.subject_id))
    RETURNING r.approved_by = r.subject_id INTO v_self_recovery;
    IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_PREVIOUS_SIGNATURE_REQUIRED: previous signing authority required'
      USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT * INTO v_rebind FROM core.wallet_identities w
  WHERE w.wallet_address = v_challenge.wallet_address AND w.chain_id = v_challenge.chain_id
    AND w.disabled_at IS NOT NULL
  ORDER BY w.disabled_at DESC, w.created_at DESC, w.id DESC
  LIMIT 1;

  SELECT s.assurance_level INTO v_before FROM core.subjects s WHERE s.id = v.subject_id;
  v_after := v_before;

  IF v_active.id IS NOT NULL THEN
    UPDATE core.wallet_identities SET disabled_at = now(), version = version + 1 WHERE id = v_active.id;
    INSERT INTO core.wallet_disable_events (
      id, tenant_id, wallet_identity_id, reason_code, replace_cause, detail, disabled_by_subject_id
    ) VALUES (
      gen_random_uuid(), v.tenant_id, v_active.id, 'replaced', p_replace_cause,
      'Replaced by wallet ' || p_wallet_id::text, v.subject_id
    );
    -- As a disable of an operator-bound wallet (0122): the operator's verification went with that
    -- wallet, so the level falls to the floor until an admin verifies the person again.
    IF v_active.bound_via = 'operator' AND NOT v_self_recovery THEN
      v_after := 'wallet_only';
    END IF;
  END IF;

  BEGIN
    INSERT INTO core.wallet_identities (
      id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, bound_via
    ) VALUES (
      p_wallet_id, v.tenant_id, v.subject_id, v_challenge.wallet_address, v_challenge.chain_id,
      'wallet_only', now(), 'proof'
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'WALLET_UNAVAILABLE: this wallet cannot be bound'
      USING ERRCODE = 'insufficient_privilege';
  END;

  UPDATE core.wallet_binding_challenges
  SET consumed_at = now(), wallet_identity_id = p_wallet_id
  WHERE id = v_challenge.id;

  -- The bind rule (0122): a proof never raises the level; the higher of the two stays.
  -- (The new row is `wallet_only`, so this keeps v_after.)
  v_after := GREATEST(
    v_after,
    (SELECT max(w.assurance_level) FROM core.wallet_identities w
     WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL)
  );
  IF v_after IS DISTINCT FROM v_before THEN
    UPDATE core.subjects SET assurance_level = v_after, version = version + 1 WHERE id = v.subject_id;
  END IF;

  RETURN QUERY SELECT p_wallet_id, v_challenge.wallet_address, v_challenge.chain_id, v_before, v_after,
    v_active.id, v_active.wallet_address, v_active.chain_id, v_active.bound_via,
    v_rebind.id, CASE WHEN v_rebind.id IS NULL THEN NULL ELSE v_rebind.subject_id = v.subject_id END;
END
$$;
