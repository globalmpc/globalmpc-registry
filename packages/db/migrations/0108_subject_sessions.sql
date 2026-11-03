-- Sessions keyed by subject, with the factors they proved — account authentication WP1.
--
-- Until now a session was a wallet: `core.sessions` held `(wallet_address, chain_id)` and every
-- request re-resolved that wallet to a subject. The account model (invitation, emailed code or
-- Google/Microsoft, then passkey or TOTP) authenticates a **subject**; a wallet becomes a signing
-- key bound to one. So:
--
-- 1. `core.subjects.assurance_level` — identity assurance moves from the wallet row to the
--    subject. It is a different dimension from the authentication level (AAL): assurance says how
--    well we know who the person is and is set by an admin with a justification; AAL says what
--    this session proved and is derived from its factors, never declared. A role needs both.
--    Backfilled from the highest level among the subject's **active** wallets — exactly the level
--    a session of that subject could reach before (a disabled wallet resolved to no subject). The
--    wallet column stays as the record of what was asserted at bind time; nothing reads it for
--    authorization any more.
--
-- 2. `core.subjects.governance_wallet_id` — decision D9. Vote weight is manual while no governance
--    token is configured; once one is, weight is read from the one wallet the subject designates,
--    never from whichever wallet happened to sign in.
--
-- 3. `core.sessions` gains `subject_id`/`tenant_id` and the factors proven: `first_factor`,
--    `second_factor`, `second_factor_at`. The wallet columns remain only for `siwe_legacy`, the
--    temporary first factor that keeps wallet sign-in working until the account flows replace it;
--    such a session counts as AAL3 only while the API runs with `LEGACY_WALLET_LOGIN=1`, and is
--    refused otherwise (the API decides; the row only records what was proven).
--    A legacy session of a wallet bound to no subject has no subject and no tenant, as before.
--
--    **Cut-over: every existing session ends here.** Old rows name a wallet, not a subject and not
--    a factor; mapping them would invent what they proved. They are deleted (a deleted token fails
--    lookup exactly as a revoked one does) and everyone signs in again.
--
--    Idle timeout: 30 minutes since the session was last used, on top of the absolute TTL (8 h,
--    set by the API at creation). Evaluated by the resolver against the database clock.
--
--    The table now has `tenant_id`, so it gets the same forced RLS as every tenant table. The API
--    loses its direct grants: it reaches sessions only through the SECURITY DEFINER functions
--    below, which is how it already used them.
--
-- 4. `core.revoke_subject_sessions(subject, reason)` — ends every live session of a subject. Wallet
--    disable calls it (AC-27: a cut key must not keep a session alive for the rest of its TTL);
--    recovery, email change and authenticator removal will.
--
-- 5. `core.purge_auth_records(now)` — expired sessions and SIWE nonces are deleted by the jobs
--    worker. Neither is history: audit events keep who signed in and out.

-- ---------------------------------------------------------------------------
-- 1–2. Subject assurance and governance wallet
-- ---------------------------------------------------------------------------

ALTER TABLE core.subjects
  ADD COLUMN assurance_level core.assurance_level NOT NULL DEFAULT 'wallet_only',
  ADD COLUMN governance_wallet_id UUID REFERENCES core.wallet_identities (id);

-- The backfill reads every tenant's wallets and writes every tenant's subjects, and both tables
-- force row-level security on their owner (0002). A migration role that is neither superuser nor
-- BYPASSRLS would see no row and leave every subject at `wallet_only` without an error — every
-- reviewer, approver and operator would lose their roles silently. Same handling as 0107:
-- `row_security = off` turns a filtered read into an error, and a role that does not bypass RLS
-- lifts FORCE for the statement and puts it back, inside this migration's transaction.
DO $$
DECLARE
  lift BOOLEAN := NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('row_security', 'off', true);
  IF lift THEN
    ALTER TABLE core.subjects NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.wallet_identities NO FORCE ROW LEVEL SECURITY;
  END IF;

  UPDATE core.subjects s
  SET assurance_level = w.level
  FROM (
    SELECT subject_id, max(assurance_level) AS level
    FROM core.wallet_identities
    WHERE subject_id IS NOT NULL AND disabled_at IS NULL
    GROUP BY subject_id
  ) w
  WHERE w.subject_id = s.id;

  IF lift THEN
    ALTER TABLE core.subjects FORCE ROW LEVEL SECURITY;
    ALTER TABLE core.wallet_identities FORCE ROW LEVEL SECURITY;
  END IF;
  PERFORM set_config('row_security', 'on', true);
  PERFORM set_config('lock_timeout', '0', true);
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Sessions keyed by subject
-- ---------------------------------------------------------------------------

-- What the session proved first. `siwe_legacy` is temporary: it goes when wallet login is removed.
CREATE TYPE core.session_first_factor AS ENUM ('email_code', 'google', 'microsoft', 'siwe_legacy');
-- What it proved second. Recovery codes restore the second factor; they count as one here.
CREATE TYPE core.session_second_factor AS ENUM ('passkey', 'totp', 'recovery_code');

DELETE FROM core.sessions;

ALTER TABLE core.sessions
  ADD COLUMN tenant_id        UUID REFERENCES core.tenants (id),
  ADD COLUMN subject_id       UUID,
  ADD COLUMN first_factor     core.session_first_factor NOT NULL,
  ADD COLUMN second_factor    core.session_second_factor,
  ADD COLUMN second_factor_at TIMESTAMPTZ,
  -- Why it ended: `logout`, `wallet_disabled`, … A short code, never free text.
  ADD COLUMN revoked_reason   TEXT CHECK (revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  ALTER COLUMN wallet_address DROP NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  ADD CONSTRAINT sessions_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  ADD CONSTRAINT sessions_subject_and_tenant_together
    CHECK ((subject_id IS NULL) = (tenant_id IS NULL)),
  -- Only a legacy wallet session may lack a subject: every account factor authenticates one.
  ADD CONSTRAINT sessions_subject_required
    CHECK (subject_id IS NOT NULL OR first_factor = 'siwe_legacy'),
  -- The wallet columns record what a legacy session signed with, and nothing else.
  ADD CONSTRAINT sessions_wallet_only_for_legacy
    CHECK ((first_factor = 'siwe_legacy') = (wallet_address IS NOT NULL AND chain_id IS NOT NULL)),
  ADD CONSTRAINT sessions_second_factor_time
    CHECK ((second_factor IS NULL) = (second_factor_at IS NULL)),
  -- A wallet signature is the legacy session's whole proof; no second factor is layered on it.
  ADD CONSTRAINT sessions_legacy_single_factor
    CHECK (first_factor <> 'siwe_legacy' OR second_factor IS NULL),
  ADD CONSTRAINT sessions_revoked_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));

CREATE INDEX sessions_subject_idx ON core.sessions (subject_id) WHERE revoked_at IS NULL;

ALTER TABLE core.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.sessions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

REVOKE ALL ON core.sessions FROM mpc_app;

-- The wallet-keyed functions go: nothing may create or resolve a session that names no factor.
DROP FUNCTION core.create_session(UUID, TEXT, TEXT, INTEGER, INTEGER);
DROP FUNCTION core.resolve_session_token(TEXT);
DROP FUNCTION core.resolve_wallet_session(TEXT, INTEGER);

/**
 * Creates a session for a subject that proved an account first factor (and optionally a second).
 *
 * The subject must be a person: services use service tokens (0109), never sessions. The tenant is
 * read from the subject, not taken from the caller, and must be the caller's tenant context
 * (`app.current_tenant`): a login flow mints only inside the tenant it authenticated against, so a
 * subject id from another tenant is refused rather than turned into a session there.
 *
 * This function trusts the caller for the factors it records. WP2/WP3 must bind `p_first_factor`
 * and `p_second_factor` to a verified, consumed challenge row (email code, OIDC state, WebAuthn or
 * TOTP challenge) before calling it; until then only tests call it.
 */
CREATE FUNCTION core.create_subject_session(
  p_id UUID,
  p_token_hash TEXT,
  p_subject_id UUID,
  p_first_factor core.session_first_factor,
  p_second_factor core.session_second_factor,
  p_ttl_seconds INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_tenant UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_first_factor = 'siwe_legacy' THEN
    RAISE EXCEPTION 'a wallet session is created by core.create_wallet_session'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tenant_id INTO v_tenant FROM core.subjects WHERE id = p_subject_id AND kind = 'person';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no person subject %', p_subject_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_tenant IS DISTINCT FROM core.current_tenant() THEN
    RAISE EXCEPTION 'subject % is not in the current tenant', p_subject_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO core.sessions (
    id, token_hash, tenant_id, subject_id, first_factor, second_factor, second_factor_at, expires_at
  ) VALUES (
    p_id, p_token_hash, v_tenant, p_subject_id, p_first_factor, p_second_factor,
    CASE WHEN p_second_factor IS NULL THEN NULL ELSE now() END,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$$;

/**
 * Creates a legacy wallet session after the API verified a SIWE signature.
 *
 * The subject is the one the **active** wallet is bound to on that chain, looked up here — the
 * caller states only what was signed. A wallet bound to no subject (or only through a disabled
 * row) gets a session with no subject and no tenant: public reads only, as before.
 */
CREATE FUNCTION core.create_wallet_session(
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
  WHERE w.wallet_address = p_wallet AND w.chain_id = p_chain_id AND w.disabled_at IS NULL;

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

/**
 * Finds a live session by token hash and marks it used.
 *
 * Refused (no row): revoked, past its absolute expiry, idle for 30 minutes or more, or a legacy
 * wallet session whose wallet is no longer an active binding of its subject. The last one is
 * belt and braces — disabling a wallet revokes its subject's sessions — but a binding changed by
 * any other path must not leave a session acting through a key the subject no longer holds.
 *
 * Returns the subject's **current** identity assurance — for a legacy wallet session, no higher
 * than the signing wallet's — and the API derives the AAL from the factors.
 */
CREATE FUNCTION core.resolve_session(p_token_hash TEXT)
RETURNS TABLE (
  session_id       UUID,
  subject_id       UUID,
  tenant_id        UUID,
  first_factor     core.session_first_factor,
  second_factor    core.session_second_factor,
  second_factor_at TIMESTAMPTZ,
  wallet_address   TEXT,
  chain_id         INTEGER,
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
    AND (
      s.first_factor <> 'siwe_legacy'
      OR s.subject_id IS NULL
      OR EXISTS (
        SELECT 1 FROM core.wallet_identities w
        WHERE w.subject_id = s.subject_id
          AND w.wallet_address = s.wallet_address
          AND w.chain_id = s.chain_id
          AND w.disabled_at IS NULL
      )
    )
  RETURNING
    s.id, s.subject_id, s.tenant_id, s.first_factor, s.second_factor, s.second_factor_at,
    s.wallet_address, s.chain_id,
    -- A legacy wallet session is held to the lower of the subject's level and the level asserted
    -- for the wallet that signed: assurance is the subject's, but before 0108 a session signed
    -- with a weaker wallet of the same subject had only that wallet's level, and signing with it
    -- must not now reach the roles of the strongest one.
    (
      SELECT CASE
        WHEN s.first_factor = 'siwe_legacy' THEN LEAST(
          subject.assurance_level,
          (
            SELECT w.assurance_level FROM core.wallet_identities w
            WHERE w.subject_id = s.subject_id
              AND w.wallet_address = s.wallet_address
              AND w.chain_id = s.chain_id
              AND w.disabled_at IS NULL
          )
        )
        ELSE subject.assurance_level
      END
      FROM core.subjects subject WHERE subject.id = s.subject_id
    ),
    s.expires_at
$$;

-- Same signature as 0010, so the grant carries over; now records why the session ended.
CREATE OR REPLACE FUNCTION core.revoke_session(p_token_hash TEXT) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'logout'
  WHERE token_hash = p_token_hash AND revoked_at IS NULL
  RETURNING true
$$;

/**
 * Ends every live session of a subject in the caller's tenant context. Returns how many it ended;
 * a subject of another tenant (or no tenant context) ends none.
 */
CREATE FUNCTION core.revoke_subject_sessions(p_subject_id UUID, p_reason TEXT) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = p_reason
  WHERE subject_id = p_subject_id AND tenant_id = core.current_tenant() AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE EXECUTE ON FUNCTION core.create_subject_session(
  UUID, TEXT, UUID, core.session_first_factor, core.session_second_factor, INTEGER
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.create_wallet_session(UUID, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.resolve_session(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.revoke_subject_sessions(UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.create_subject_session(
  UUID, TEXT, UUID, core.session_first_factor, core.session_second_factor, INTEGER
) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.create_wallet_session(UUID, TEXT, TEXT, INTEGER, INTEGER) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.resolve_session(TEXT) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.revoke_subject_sessions(UUID, TEXT) TO mpc_app;

-- ---------------------------------------------------------------------------
-- 5. Purge
-- ---------------------------------------------------------------------------

/**
 * Deletes sessions and SIWE nonces that can no longer be used.
 *
 * A session is kept for a day after it expired or was revoked, so an incident responder can still
 * see when a recently ended session was last used; after that the audit trail holds what matters.
 * A nonce is useless the moment it expires (verification requires `expires_at > now()`), consumed
 * or not.
 *
 * Takes no time argument: the cut-off is the database's own clock, so a caller cannot pass a
 * future time and purge live sessions or unexpired nonces.
 */
CREATE FUNCTION core.purge_auth_records()
RETURNS TABLE (purged_sessions INTEGER, purged_nonces INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_sessions INTEGER;
  v_nonces INTEGER;
BEGIN
  DELETE FROM core.sessions
  WHERE expires_at <= now() - interval '1 day'
     OR revoked_at <= now() - interval '1 day';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  DELETE FROM core.siwe_nonces WHERE expires_at <= now();
  GET DIAGNOSTICS v_nonces = ROW_COUNT;

  RETURN QUERY SELECT v_sessions, v_nonces;
END
$$;

REVOKE EXECUTE ON FUNCTION core.purge_auth_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.purge_auth_records() TO mpc_worker;
