-- 세션 토큰 저장 — R1 Task 8.
--
-- **이것이 개발용 wallet 헤더 인증을 대체한다.** 그 경로는 서명 검증 없이
-- Authorization 헤더의 주소를 믿었으므로 인증 우회에 해당했다.
--
-- 설계:
--
-- - 토큰은 opaque random 32바이트다. JWT를 쓰지 않는 이유는 즉시 폐기가
--   필요하기 때문이다 — key 분실·역할 변경·incident에서 세션을 끊을 수 있어야
--   한다(AC-27).
-- - 저장하는 것은 토큰의 **해시**다. DB가 유출돼도 세션을 탈취할 수 없다.
-- - tenant에 속하지 않는다. 로그인 시점에는 아직 tenant를 모르기 때문이며,
--   조회는 SECURITY DEFINER 함수로만 한다.

CREATE TABLE core.sessions (
  id             UUID PRIMARY KEY,
  -- 원문 토큰은 저장하지 않는다. 클라이언트만 갖고 있다.
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
 * 토큰 해시로 활성 세션을 찾는다.
 *
 * 로그인 해석과 같은 이유로 SECURITY DEFINER다 — 세션을 찾기 전에는 tenant를
 * 모른다. 만료·폐기된 세션은 반환하지 않는다.
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
