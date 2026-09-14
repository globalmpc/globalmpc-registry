-- SIWE nonce 저장.
--
-- nonce는 한 번만 쓴다. 재사용을 허용하면 서명 replay가 가능해진다.
-- tenant에 속하지 않으므로 RLS 대상이 아니며, 만료된 행은 주기적으로 지운다.

CREATE TABLE core.siwe_nonces (
  nonce          TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  chain_id       INTEGER NOT NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ
);

CREATE INDEX siwe_nonces_expiry_idx ON core.siwe_nonces (expires_at)
  WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.siwe_nonces TO mpc_app;
