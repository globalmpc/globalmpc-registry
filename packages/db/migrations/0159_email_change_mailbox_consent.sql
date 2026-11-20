ALTER TABLE core.email_challenges ADD COLUMN owner_proof_digest BYTEA;
ALTER TABLE core.email_outbox DROP CONSTRAINT email_outbox_template_check;
ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_template_check CHECK (template IN (
  'sign_in_code', 'invitation_link', 'invitation_code', 'email_change_code', 'email_change_owner',
  'email_changed_notice', 'mfa_reset_notice', 'account_suspended_notice', 'account_reinstated_notice'
));

CREATE OR REPLACE FUNCTION core.issue_email_challenge(
  p_id UUID,
  p_purpose core.email_challenge_purpose,
  p_email TEXT,
  p_tenant_id UUID,
  p_subject_id UUID,
  p_invitation_id UUID,
  p_email_change_id UUID,
  p_code_hmac BYTEA,
  p_template TEXT,
  p_recipient TEXT,
  p_code TEXT
) RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_owner_email TEXT;
  v_owner_code TEXT;
BEGIN
  IF p_code !~ '^[0-9]{8}$' THEN
    RAISE EXCEPTION 'a code is 8 digits' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM core.supersede_email_challenge(p_purpose, p_email);
  IF p_purpose = 'email_change' AND p_subject_id IS NOT NULL AND p_email_change_id IS NOT NULL THEN
    SELECT s.email INTO STRICT v_owner_email FROM core.subjects s
    WHERE s.id = p_subject_id AND s.tenant_id = p_tenant_id;
    v_owner_code := gen_random_uuid()::text;
  END IF;
  INSERT INTO core.email_challenges (
    id, purpose, email, tenant_id, subject_id, invitation_id, email_change_id, code_hmac,
    created_at, expires_at, owner_proof_digest
  ) VALUES (
    p_id, p_purpose, p_email, p_tenant_id, p_subject_id, p_invitation_id, p_email_change_id,
    p_code_hmac, v_now, v_now + interval '10 minutes',
    sha256(convert_to(v_owner_email || ':' || v_owner_code, 'UTF8'))
  );
  INSERT INTO core.email_outbox (
    id, template, recipient, params, state, settled_at, expires_at, challenge_id, invitation_id
  ) VALUES (
    gen_random_uuid(), p_template, p_recipient,
    CASE WHEN p_recipient IS NULL THEN NULL
         ELSE jsonb_build_object('code', p_code, 'expiresMinutes', 10) END,
    CASE WHEN p_recipient IS NULL THEN 'suppressed' ELSE 'pending' END,
    CASE WHEN p_recipient IS NULL THEN v_now ELSE NULL END,
    v_now + interval '10 minutes', p_id, p_invitation_id
  );
  IF v_owner_code IS NOT NULL THEN
    INSERT INTO core.email_outbox(id, template, recipient, params, state, expires_at, challenge_id)
    VALUES (gen_random_uuid(), 'email_change_owner', v_owner_email,
      jsonb_build_object('code', v_owner_code, 'destination', p_email), 'pending', v_now + interval '10 minutes', p_id);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION core.complete_email_change(
  p_new_email TEXT, p_code_hmac BYTEA, p_email_key TEXT, p_ip_key TEXT, p_owner_code TEXT
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID,
  email_change_id UUID, previous_email TEXT, revoked_sessions INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
SET row_security = off
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
  v_subject_id UUID;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry = 0 THEN
    v_retry := core.take_auth_rate('code_verify', 'email:' || p_email_key, 10, interval '15 minutes');
  END IF;
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- 0132 (F3): the person's subject row before the challenge and the request. Consuming the code
  -- locks the challenge, which a suspension holding the subject would supersede: the old order
  -- deadlocked with it. The live challenge for the address names the person; if a newer one
  -- replaces it in between, its person is locked below as before.
  SELECT c.subject_id INTO v_subject_id FROM core.email_challenges c
  WHERE c.purpose = 'email_change' AND c.email = v_email
    AND c.consumed_at IS NULL AND c.superseded_at IS NULL;
  IF v_subject_id IS NOT NULL THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;

  IF v_subject_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.email_challenges c JOIN core.subjects s ON s.id = c.subject_id AND s.tenant_id = c.tenant_id
    WHERE c.purpose = 'email_change' AND c.email = v_email AND c.subject_id = v_subject_id
      AND c.consumed_at IS NULL AND c.superseded_at IS NULL
      AND c.owner_proof_digest = sha256(convert_to(s.email || ':' || p_owner_code, 'UTF8'))
  ) THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, 0;
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

  IF NOT EXISTS (
    SELECT 1 FROM core.email_challenges c JOIN core.subjects s ON s.id = c.subject_id AND s.tenant_id = c.tenant_id
    WHERE c.id = r.challenge_id AND c.email_change_id = v.id
      AND c.owner_proof_digest = sha256(convert_to(s.email || ':' || p_owner_code, 'UTF8'))
  ) THEN
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
REVOKE ALL ON FUNCTION core.complete_email_change(TEXT,BYTEA,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_email_change(TEXT,BYTEA,TEXT,TEXT,TEXT) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_email_change(
  p_new_email TEXT, p_code_hmac BYTEA, p_email_key TEXT, p_ip_key TEXT
) RETURNS TABLE (
  status TEXT, retry_after_seconds INTEGER, tenant_id UUID, subject_id UUID,
  email_change_id UUID, previous_email TEXT, revoked_sessions INTEGER
)
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog, core, pg_temp
SET row_security = off
AS $$ SELECT * FROM core.complete_email_change($1,$2,$3,$4,NULL::text) $$;
