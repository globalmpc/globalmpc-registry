-- Wallet sign-in removed — account authentication WP7, decision D3.
--
-- Wallets stay as signing keys bound by proof of possession (0122); no wallet signature signs
-- anyone in any more. Here:
--
-- 1. Every `siwe_legacy` session still live is revoked (`legacy_wallet_login_removed`). There are
--    no production users; the shared dev deployment's operators sign in again with an email
--    (bootstrap). No mapping of old wallet sessions to account sessions is attempted.
-- 2. `sessions_no_live_wallet_login`: a `siwe_legacy` row can exist only revoked. The enum value
--    stays — PostgreSQL cannot drop one in place, and the revoked rows (kept a day for incident
--    response, then purged) still carry it — so the constraint is what keeps a new one out, for
--    every role that can write the table, not just the API.
-- 3. `core.create_wallet_session` (the SIWE session) is dropped, and so is `core.siwe_nonces`.
--    `core.purge_auth_records` no longer deletes nonces and returns only `purged_sessions`.
-- 4. `core.resolve_session` loses the wallet branch and the wallet columns: it resolves only
--    account sessions. The wallet columns of `core.sessions` stay (the revoked rows' CHECKs still
--    describe them) and nothing reads them.
--
-- | Case | Before | After |
-- | --- | --- | --- |
-- | Live SIWE session | Resolves while `LEGACY_WALLET_LOGIN` is on | Revoked here; cannot be inserted or revived |
-- | Revoked / expired SIWE session | Kept, then purged after a day | Same |
-- | Account session | Unchanged | Unchanged |
-- | Nonce row | Purged on expiry | Table gone |

-- ---------------------------------------------------------------------------
-- 1. Revoke every live SIWE session
-- ---------------------------------------------------------------------------

-- Same handling as 0108 / 0116: sessions force RLS on their owner, so a migration role that does
-- not bypass it lifts FORCE for this statement and puts it back.
DO $$
DECLARE
  lift BOOLEAN := NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user);
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('row_security', 'off', true);
  IF lift THEN
    ALTER TABLE core.sessions NO FORCE ROW LEVEL SECURITY;
  END IF;

  -- Expired ones too: the constraint below holds for every row, not only live ones.
  UPDATE core.sessions
  SET revoked_at = now(), revoked_reason = 'legacy_wallet_login_removed'
  WHERE first_factor = 'siwe_legacy' AND revoked_at IS NULL;

  -- 2. No live wallet session, ever again. Added here, under the same lock timeout: waiting
  --    for the exclusive lock without one would hold up every `resolve_session` behind it.
  ALTER TABLE core.sessions
    ADD CONSTRAINT sessions_no_live_wallet_login
      CHECK (first_factor <> 'siwe_legacy' OR revoked_at IS NOT NULL);

  IF lift THEN
    ALTER TABLE core.sessions FORCE ROW LEVEL SECURITY;
  END IF;
  PERFORM set_config('row_security', 'on', true);
  PERFORM set_config('lock_timeout', '0', true);
END
$$;

-- ---------------------------------------------------------------------------
-- 3. The SIWE session function, nonces and their purge
-- ---------------------------------------------------------------------------

DROP FUNCTION core.create_wallet_session(UUID, TEXT, TEXT, INTEGER, INTEGER);

DROP FUNCTION core.purge_auth_records();

/**
 * 0108's purge without the nonces: deletes sessions a day after they expired or were revoked, so
 * an incident responder can still see when a recently ended session was last used.
 *
 * Takes no time argument: the cut-off is the database's own clock, so a caller cannot pass a
 * future time and purge live sessions.
 */
CREATE FUNCTION core.purge_auth_records()
RETURNS TABLE (purged_sessions INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
DECLARE
  v_sessions INTEGER;
BEGIN
  DELETE FROM core.sessions
  WHERE expires_at <= now() - interval '1 day'
     OR revoked_at <= now() - interval '1 day';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  RETURN QUERY SELECT v_sessions;
END
$$;

REVOKE EXECUTE ON FUNCTION core.purge_auth_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.purge_auth_records() TO mpc_worker;

DROP TABLE core.siwe_nonces;

-- ---------------------------------------------------------------------------
-- 4. The resolver, account sessions only
-- ---------------------------------------------------------------------------

DROP FUNCTION core.resolve_session(TEXT);

/**
 * 0116's resolver without the wallet session: a session resolves when it is live, not idle for
 * 30 minutes, an account session, and its second factor's authenticator is not revoked
 * (priority rule 1). The `siwe_legacy` test is redundant with the constraint above and kept so
 * the resolver does not depend on it.
 */
CREATE FUNCTION core.resolve_session(p_token_hash TEXT)
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

REVOKE EXECUTE ON FUNCTION core.resolve_session(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_session(TEXT) TO mpc_app;
