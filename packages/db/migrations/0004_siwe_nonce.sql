-- SIWE nonce storage.
--
-- A nonce is single-use. Allowing reuse would enable signature replay.
-- Not tenant-scoped, so not subject to RLS; expired rows are purged periodically.

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
