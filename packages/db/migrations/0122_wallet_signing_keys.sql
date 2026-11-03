-- Wallets as signing keys — account authentication WP5.
--
-- A wallet no longer signs anyone in; it is a key a person holds for signatures (attestations,
-- gate decisions) and, once a governance token exists, the source of vote weight (D9). Until now
-- an admin bound a wallet to a subject by typing its address. That lets an admin attach a key
-- they hold to someone else's account (plan §5, acceptance 9), so here:
--
-- 1. **Binding needs proof of possession.** The holder asks for a challenge from their own
--    account session and signs it (EIP-712, verified by the API); `core.bind_wallet_by_proof`
--    spends the challenge — single use, five minutes, bound to the session that asked, to the
--    subject, the tenant, the chain and the address — and inserts the wallet. The session must
--    hold the strongest factor the subject has (aal3 while any passkey is active, else aal2),
--    the rule WP3 applies to adding and removing factors, and must not be recovery-limited.
--
-- 2. **The application role can no longer insert wallets** or change who a wallet belongs to.
--    It keeps `UPDATE (disabled_at, version)` for the admin disable (AC-27, one person, as
--    before). Everything else goes through the SECURITY DEFINER functions below, so "an admin
--    cannot attach a wallet" is a property of the grants, not of a route that happens not to
--    exist. Bootstrap and seeds use the migration connection, as they do for subjects (0112).
--
-- 3. **`bound_via`** records how a binding was made: `operator` (bootstrap or the removed admin
--    bind; every existing row) or `proof` (this ceremony). A proof-bound wallet is never a legacy
--    SIWE login: `core.create_wallet_session` resolves only operator-bound wallets to a subject.
--    Otherwise binding a key from a TOTP session would, while `LEGACY_WALLET_LOGIN=1`, be a way
--    to an aal3 session without a passkey.
--
--    Identity assurance stays the subject's (0108). A proof proves possession, not identity: the
--    wallet row records `wallet_only`, and the subject keeps the higher of its level and its
--    active wallets' — the 0108 backfill rule, which therefore never changes on a proof bind.
--    Disabling a proof-bound wallet never lowers the subject either; disabling an operator-bound
--    one recomputes from the active wallets, as it did before (admin route).
--
-- 4. **Self-service disable** (`core.disable_own_wallet`): aal2 or more, not recovery-limited;
--    records the reason like the admin disable and ends every session of the subject (AC-27).
--
-- 5. **Governance wallet (D9)**: `core.designate_governance_wallet` needs aal3 and one of the
--    subject's own active wallets on the API's chain; a composite foreign key keeps
--    `subjects.governance_wallet_id` pointing at a wallet of that same subject, and the
--    application role can no longer write the column directly.

-- ---------------------------------------------------------------------------
-- 3. How a binding was made
-- ---------------------------------------------------------------------------

ALTER TABLE core.wallet_identities
  ADD COLUMN bound_via TEXT NOT NULL DEFAULT 'operator' CHECK (bound_via IN ('operator', 'proof')),
  -- Target of the governance-wallet key below.
  ADD CONSTRAINT wallet_identities_id_subject_key UNIQUE (id, subject_id);

-- ---------------------------------------------------------------------------
-- 5. A governance wallet is the subject's own
-- ---------------------------------------------------------------------------

ALTER TABLE core.subjects
  ADD CONSTRAINT subjects_governance_wallet_own
    FOREIGN KEY (governance_wallet_id, id) REFERENCES core.wallet_identities (id, subject_id);

-- ---------------------------------------------------------------------------
-- 2. Grants
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE ON core.wallet_identities FROM mpc_app;
GRANT UPDATE (disabled_at, version) ON core.wallet_identities TO mpc_app;

REVOKE INSERT (governance_wallet_id), UPDATE (governance_wallet_id) ON core.subjects FROM mpc_app;

-- ---------------------------------------------------------------------------
-- 1. Binding challenges
-- ---------------------------------------------------------------------------

CREATE TABLE core.wallet_binding_challenges (
  id                 UUID PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES core.tenants (id),
  subject_id         UUID NOT NULL,
  session_id         UUID NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
  wallet_address     TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  chain_id           INTEGER NOT NULL,
  -- 32 random bytes the API chose, signed as the EIP-712 `nonce`.
  nonce              TEXT NOT NULL UNIQUE CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ,
  wallet_identity_id UUID REFERENCES core.wallet_identities (id),
  CONSTRAINT wallet_binding_challenges_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT wallet_binding_challenges_ttl
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
  -- Spent exactly when it produced a binding.
  CONSTRAINT wallet_binding_challenges_consumed_together
    CHECK ((consumed_at IS NULL) = (wallet_identity_id IS NULL))
);

CREATE INDEX wallet_binding_challenges_session_idx ON core.wallet_binding_challenges (session_id)
  WHERE consumed_at IS NULL;

ALTER TABLE core.wallet_binding_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.wallet_binding_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.wallet_binding_challenges
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- ---------------------------------------------------------------------------
-- Session strength
-- ---------------------------------------------------------------------------

/**
 * Refuses a session weaker than `p_minimum` (2 = TOTP or recovery code, 3 = passkey) or than the
 * strongest factor the subject holds when `p_strongest_held`, and any recovery-limited session.
 * Raises the MFA refusal codes the API already answers (0116).
 */
CREATE FUNCTION core.wallet_assert_session(v core.sessions, p_minimum INTEGER, p_strongest_held BOOLEAN)
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

-- ---------------------------------------------------------------------------
-- 1. Binding
-- ---------------------------------------------------------------------------

/**
 * Issues the session's binding challenge for one address on one chain and returns its times. A
 * session holds one live challenge; asking again replaces it. Refused to a session that could not
 * complete the binding, so nobody signs for nothing.
 */
CREATE FUNCTION core.create_wallet_binding_challenge(
  p_session_id UUID,
  p_challenge_id UUID,
  p_wallet TEXT,
  p_chain_id INTEGER,
  p_nonce TEXT
) RETURNS TABLE (issued_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, tenant_id UUID, subject_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
BEGIN
  PERFORM core.wallet_assert_session(v, 2, true);

  DELETE FROM core.wallet_binding_challenges c WHERE c.session_id = v.id AND c.consumed_at IS NULL;
  RETURN QUERY
  INSERT INTO core.wallet_binding_challenges AS c (
    id, tenant_id, subject_id, session_id, wallet_address, chain_id, nonce, issued_at, expires_at
  ) VALUES (
    p_challenge_id, v.tenant_id, v.subject_id, v.id, lower(p_wallet), p_chain_id, p_nonce,
    date_trunc('second', now()), date_trunc('second', now()) + interval '5 minutes'
  )
  RETURNING c.issued_at, c.expires_at, c.tenant_id, c.subject_id;
END
$$;

/**
 * The session's live binding challenge with that id, or no row. The API rebuilds the signed
 * message from it — never from the request — and verifies the signature against it.
 */
CREATE FUNCTION core.live_wallet_binding_challenge(p_session_id UUID, p_challenge_id UUID)
RETURNS TABLE (
  id UUID, tenant_id UUID, subject_id UUID, wallet_address TEXT, chain_id INTEGER, nonce TEXT,
  issued_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT c.id, c.tenant_id, c.subject_id, c.wallet_address, c.chain_id, c.nonce, c.issued_at, c.expires_at
  FROM core.wallet_binding_challenges c
  WHERE c.id = p_challenge_id AND c.session_id = p_session_id AND c.tenant_id = core.current_tenant()
    AND c.consumed_at IS NULL AND c.expires_at > now()
$$;

/**
 * Binds the challenge's wallet to the session's subject after the API verified that `p_signer`
 * signed it. The challenge is spent here, in the transaction that binds; a second call finds it
 * spent. An address already bound — to anyone, in any tenant, active or disabled — is refused
 * with one code, `WALLET_UNAVAILABLE`, so the answer does not say where.
 *
 * Returns the subject's identity assurance before and after (the 0108 rule, see the header).
 */
CREATE FUNCTION core.bind_wallet_by_proof(
  p_session_id UUID,
  p_challenge_id UUID,
  p_signer TEXT,
  p_wallet_id UUID
) RETURNS TABLE (
  wallet_id UUID, wallet_address TEXT, chain_id INTEGER,
  previous_assurance core.assurance_level, assurance core.assurance_level
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge core.wallet_binding_challenges;
  v_before core.assurance_level;
  v_after core.assurance_level;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, true);

  SELECT * INTO v_challenge FROM core.wallet_binding_challenges c
  WHERE c.id = p_challenge_id AND c.session_id = v.id AND c.tenant_id = v.tenant_id
    AND c.subject_id = v.subject_id AND c.consumed_at IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR v_challenge.wallet_address <> lower(p_signer) THEN
    RAISE EXCEPTION 'WALLET_CHALLENGE_INVALID: no live binding challenge of this session matches'
      USING ERRCODE = 'insufficient_privilege';
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

  SELECT s.assurance_level INTO v_before FROM core.subjects s WHERE s.id = v.subject_id;
  v_after := GREATEST(
    v_before,
    (SELECT max(w.assurance_level) FROM core.wallet_identities w
     WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL)
  );
  IF v_after IS DISTINCT FROM v_before THEN
    UPDATE core.subjects SET assurance_level = v_after, version = version + 1 WHERE id = v.subject_id;
  END IF;

  RETURN QUERY SELECT p_wallet_id, v_challenge.wallet_address, v_challenge.chain_id, v_before, v_after;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Disabling one's own wallet
-- ---------------------------------------------------------------------------

/**
 * Disables one of the session's subject's active wallets, records why, and ends every session of
 * the subject, this one included (AC-27: whoever may hold the key must not keep a session).
 * An operator-bound wallet's level stops counting toward the subject's; a proof-bound one never
 * counted.
 */
CREATE FUNCTION core.disable_own_wallet(
  p_session_id UUID,
  p_wallet_id UUID,
  p_reason_code TEXT,
  p_detail TEXT
) RETURNS TABLE (
  wallet_address TEXT, chain_id INTEGER, bound_via TEXT, version INTEGER, revoked_sessions INTEGER,
  previous_assurance core.assurance_level, assurance core.assurance_level
)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_wallet core.wallet_identities;
  v_before core.assurance_level;
  v_after core.assurance_level;
  v_revoked INTEGER;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, false);

  SELECT * INTO v_wallet FROM core.wallet_identities w
  WHERE w.id = p_wallet_id AND w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id
    AND w.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_UNKNOWN: not an active wallet of this subject' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE core.wallet_identities SET disabled_at = now(), version = version + 1 WHERE id = v_wallet.id;
  INSERT INTO core.wallet_disable_events (
    id, tenant_id, wallet_identity_id, reason_code, detail, disabled_by_subject_id
  ) VALUES (gen_random_uuid(), v.tenant_id, v_wallet.id, p_reason_code, p_detail, v.subject_id);

  SELECT s.assurance_level INTO v_before FROM core.subjects s WHERE s.id = v.subject_id;
  v_after := v_before;
  IF v_wallet.bound_via = 'operator' THEN
    v_after := COALESCE(
      (SELECT max(w.assurance_level) FROM core.wallet_identities w
       WHERE w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id AND w.disabled_at IS NULL),
      'wallet_only'
    );
    IF v_after IS DISTINCT FROM v_before THEN
      UPDATE core.subjects SET assurance_level = v_after, version = version + 1 WHERE id = v.subject_id;
    END IF;
  END IF;

  UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'wallet_disabled'
  WHERE subject_id = v.subject_id AND tenant_id = v.tenant_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  RETURN QUERY SELECT v_wallet.wallet_address, v_wallet.chain_id, v_wallet.bound_via,
    v_wallet.version + 1, v_revoked, v_before, v_after;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Governance wallet (D9)
-- ---------------------------------------------------------------------------

/**
 * Designates one of the subject's own active wallets on `p_chain_id` as the one whose token
 * balance is its vote weight once a governance token is configured. Needs a passkey session:
 * moving the weight source moves voting power. Returns the previous designation.
 */
CREATE FUNCTION core.designate_governance_wallet(p_session_id UUID, p_wallet_id UUID, p_chain_id INTEGER)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_previous UUID;
BEGIN
  PERFORM core.wallet_assert_session(v, 3, false);

  PERFORM 1 FROM core.wallet_identities w
  WHERE w.id = p_wallet_id AND w.subject_id = v.subject_id AND w.tenant_id = v.tenant_id
    AND w.chain_id = p_chain_id AND w.disabled_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_UNKNOWN: not an active wallet of this subject on this chain'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT governance_wallet_id INTO v_previous FROM core.subjects WHERE id = v.subject_id;
  UPDATE core.subjects SET governance_wallet_id = p_wallet_id, version = version + 1
  WHERE id = v.subject_id;
  RETURN v_previous;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Legacy sign-in resolves only operator-bound wallets
-- ---------------------------------------------------------------------------

/**
 * 0108's legacy wallet session, unchanged except that a proof-bound wallet resolves to no
 * subject: it signs, it never signs in (header, item 3).
 */
CREATE OR REPLACE FUNCTION core.create_wallet_session(
  p_id UUID, p_token_hash TEXT, p_wallet TEXT, p_chain_id INTEGER, p_ttl_seconds INTEGER
) RETURNS TABLE (expires_at TIMESTAMPTZ, subject_id UUID, tenant_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_subject UUID;
  v_tenant UUID;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT w.subject_id, w.tenant_id INTO v_subject, v_tenant
  FROM core.wallet_identities w
  JOIN core.subjects s ON s.id = w.subject_id AND s.kind = 'person'
  WHERE w.wallet_address = p_wallet AND w.chain_id = p_chain_id AND w.disabled_at IS NULL
    AND w.bound_via = 'operator';

  RETURN QUERY
  INSERT INTO core.sessions AS s (
    id, token_hash, tenant_id, subject_id, first_factor, wallet_address, chain_id, expires_at
  ) VALUES (
    p_id, p_token_hash, v_tenant, v_subject, 'siwe_legacy', p_wallet, p_chain_id,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING s.expires_at, s.subject_id, s.tenant_id;
END
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  core.wallet_assert_session(core.sessions, INTEGER, BOOLEAN),
  core.create_wallet_binding_challenge(UUID, UUID, TEXT, INTEGER, TEXT),
  core.live_wallet_binding_challenge(UUID, UUID),
  core.bind_wallet_by_proof(UUID, UUID, TEXT, UUID),
  core.disable_own_wallet(UUID, UUID, TEXT, TEXT),
  core.designate_governance_wallet(UUID, UUID, INTEGER)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  core.create_wallet_binding_challenge(UUID, UUID, TEXT, INTEGER, TEXT),
  core.live_wallet_binding_challenge(UUID, UUID),
  core.bind_wallet_by_proof(UUID, UUID, TEXT, UUID),
  core.disable_own_wallet(UUID, UUID, TEXT, TEXT),
  core.designate_governance_wallet(UUID, UUID, INTEGER)
TO mpc_app;
