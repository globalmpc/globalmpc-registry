-- Session token storage — R1 Task 8.
--
-- **This replaces the dev wallet-header auth.** That path trusted the address in the
-- Authorization header without verifying a signature, which amounted to an auth bypass.
--
-- Design:
--
-- - Tokens are opaque random 32 bytes. JWT is not used because immediate revocation
--   is required — sessions must be cut on key loss, role change, or incident
--   (AC-27).
-- - Only the token **hash** is stored. A DB leak does not allow session hijacking.
-- - Not tenant-scoped, because the tenant is not yet known at login;
--   lookups go only through SECURITY DEFINER functions.

CREATE TABLE core.sessions (
  id             UUID PRIMARY KEY,
  -- The raw token is not stored. Only the client has it.
  token_hash     TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^0x[0-9a-f]{64}$'),
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  chain_id       INTEGER NOT NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  last_seen_at   TIMESTAMPTZ,
  CONSTRAINT session_expiry CHECK (expires_at > issued_at)
);

CREATE INDEX sessions_active_idx ON core.sessions (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX sessions_wallet_idx ON core.sessions (wallet_address)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON core.sessions TO mpc_app;

/**
 * Finds an active session by token hash.
 *
 * SECURITY DEFINER for the same reason as login resolution — the tenant is unknown until
 * the session is found. Expired or revoked sessions are not returned.
 */
CREATE FUNCTION core.resolve_session_token(p_token_hash TEXT)
RETURNS TABLE (wallet_address TEXT, chain_id INTEGER, session_id UUID)
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
  UPDATE core.sessions
  SET last_seen_at = now()
  WHERE token_hash = p_token_hash
    AND revoked_at IS NULL
    AND expires_at > now()
  RETURNING wallet_address, chain_id, id
$$;

CREATE FUNCTION core.create_session(
  p_id UUID, p_token_hash TEXT, p_wallet TEXT, p_chain_id INTEGER, p_ttl_seconds INTEGER
) RETURNS TIMESTAMPTZ
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
  INSERT INTO core.sessions (id, token_hash, wallet_address, chain_id, expires_at)
  VALUES (p_id, p_token_hash, p_wallet, p_chain_id, now() + make_interval(secs => p_ttl_seconds))
  RETURNING expires_at
$$;

CREATE FUNCTION core.revoke_session(p_token_hash TEXT) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
  UPDATE core.sessions SET revoked_at = now()
  WHERE token_hash = p_token_hash AND revoked_at IS NULL
  RETURNING true
$$;

REVOKE EXECUTE ON FUNCTION core.resolve_session_token(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.create_session(UUID, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.revoke_session(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.resolve_session_token(TEXT) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.create_session(UUID, TEXT, TEXT, INTEGER, INTEGER) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.revoke_session(TEXT) TO mpc_app;
