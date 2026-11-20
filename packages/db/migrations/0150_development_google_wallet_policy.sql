-- The deployment owner selects the wallet binding policy after migrations.
-- No runtime role can enable the development exception.
CREATE TABLE core.development_google_wallet_policy (
  enabled BOOLEAN PRIMARY KEY CHECK (enabled)
);
REVOKE ALL ON core.development_google_wallet_policy FROM PUBLIC, mpc_app, mpc_worker;

CREATE OR REPLACE FUNCTION core.wallet_assert_session(v core.sessions, p_minimum INTEGER, p_strongest_held BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_required INTEGER := p_minimum;
BEGIN
  IF v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_RECOVERY_REENROLMENT_REQUIRED: enrol a new factor first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only the two wallet-binding functions request this combination. Governance,
  -- session management and recovery still require their original factors.
  IF p_minimum = 2 AND p_strongest_held AND v.first_factor = 'google'
     AND EXISTS (SELECT 1 FROM core.development_google_wallet_policy) THEN
    RETURN;
  END IF;
  IF p_strongest_held AND core.mfa_has_passkey(v.subject_id) THEN
    v_required := GREATEST(v_required, 3);
  END IF;
  IF core.mfa_session_rank(v) < v_required THEN
    RAISE EXCEPTION '%: this needs a session at aal%',
      CASE WHEN v_required = 3 THEN 'MFA_PASSKEY_REQUIRED' ELSE 'MFA_STEP_UP_REQUIRED' END, v_required
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
