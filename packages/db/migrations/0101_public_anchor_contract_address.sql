-- Public proofs and hash lookups state the contract the anchor was actually sent to.
--
-- An anchor is identified by (chain, contract, batch id). The contract is not upgradeable: a new
-- version is deployed at a new address and the old one stays readable, so after such a
-- deployment a verifier holding only the chain and the transaction hash has to guess which
-- contract to ask for the root. The transaction row already records the contract: the anchor
-- worker writes `contract_address` in the same UPDATE that records a transaction hash (EOA send,
-- reconciliation from chain, following another transaction) or, on the Safe path, when it
-- records the proposal whose target that contract is. Both functions now return that stored
-- value; nothing reads the API's or worker's current configuration.
--
-- Input scope and priority are those of `chain_id` (0099): the same latest transaction row, and
-- NULL until that row carries a hash. A row anchored before the worker recorded the contract
-- keeps NULL — it is not filled in from the current configuration, which may name a contract
-- that never held this root.
--
-- The stored contract is frozen with its hash. The guard below rejects changing
-- `contract_address` on a row whose `tx_hash` is set unless the same UPDATE also replaces or
-- clears that hash, so no single UPDATE splits a recorded (hash, contract) pair or back-fills a
-- NULL. It guards accidental rewrites, not a role that clears the hash and sets it again in two
-- statements; that role can already write any hash. The worker already holds table-level UPDATE on `chain.transactions` (0012); no
-- grant changes.
--
-- Boundary (0009, 0040, 0099) unchanged: only published versions, no tenant_id or submitter. The
-- contract address is public by construction — it is the anchor contract itself. The return
-- type changes, so each function is dropped and created again with its grants.

CREATE FUNCTION chain.guard_transaction_contract_address() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the contract of a recorded transaction hash cannot be changed'
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER transactions_contract_address_frozen
  BEFORE UPDATE ON chain.transactions
  FOR EACH ROW
  WHEN (
    OLD.tx_hash IS NOT NULL
    AND NEW.tx_hash IS NOT DISTINCT FROM OLD.tx_hash
    AND NEW.contract_address IS DISTINCT FROM OLD.contract_address
  )
  EXECUTE FUNCTION chain.guard_transaction_contract_address();

DROP FUNCTION core.public_inclusion_proof(UUID);

CREATE FUNCTION core.public_inclusion_proof(p_entry_version_id UUID)
RETURNS TABLE (
  leaf_hash             TEXT,
  batch_row_id          UUID,
  merkle_root           TEXT,
  external_batch_id     TEXT,
  transaction_state     TEXT,
  transaction_hash      TEXT,
  block_number          BIGINT,
  policy_version        TEXT,
  schema_version        TEXT,
  serialization_version TEXT,
  chain_id              INTEGER,
  contract_address      TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT l.leaf_hash, l.batch_id, b.merkle_root, b.batch_id,
         t.state::text, t.tx_hash, t.block_number,
         v.policy_version, v.schema_version, v.serialization_version,
         CASE WHEN t.tx_hash IS NOT NULL THEN t.chain_id END,
         CASE WHEN t.tx_hash IS NOT NULL THEN t.contract_address END
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  LEFT JOIN LATERAL (
    SELECT state, tx_hash, block_number, chain_id, contract_address FROM chain.transactions
    WHERE batch_id = b.id ORDER BY created_at DESC LIMIT 1
  ) t ON true
  WHERE l.entry_version_id = p_entry_version_id
    -- Proofs are not provided for unpublished versions.
    AND v.status IN ('published', 'revoked', 'superseded')
$$;

REVOKE EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) TO mpc_app;

DROP FUNCTION core.public_hash_lookup(TEXT);

CREATE FUNCTION core.public_hash_lookup(p_hash TEXT)
RETURNS TABLE (
  matched_on        TEXT,
  registry_type     TEXT,
  public_key        TEXT,
  entry_version_id  UUID,
  version           INTEGER,
  status            TEXT,
  merkle_root       TEXT,
  transaction_hash  TEXT,
  chain_id          INTEGER,
  contract_address  TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT CASE
           WHEN l.leaf_hash = p_hash THEN 'leaf_hash'
           WHEN b.merkle_root = p_hash THEN 'merkle_root'
           WHEN b.batch_id = p_hash THEN 'batch_id'
           ELSE 'transaction_hash'
         END,
         e.registry_type::text,
         e.public_key,
         v.id,
         v.version,
         v.status::text,
         b.merkle_root,
         latest_tx.tx_hash,
         CASE WHEN latest_tx.tx_hash IS NOT NULL THEN latest_tx.chain_id END,
         CASE WHEN latest_tx.tx_hash IS NOT NULL THEN latest_tx.contract_address END
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  JOIN core.registry_entries e ON e.id = v.entry_id
  -- Displays the most recent submission. Lookups by a replaced earlier tx hash reach the same batch.
  LEFT JOIN LATERAL (
    SELECT t.tx_hash, t.chain_id, t.contract_address FROM chain.transactions t
    WHERE t.batch_id = b.id ORDER BY t.created_at DESC LIMIT 1
  ) latest_tx ON true
  WHERE (
          l.leaf_hash = p_hash
       OR b.merkle_root = p_hash
       OR b.batch_id = p_hash
       OR EXISTS (
            SELECT 1 FROM chain.transactions t
            WHERE t.batch_id = b.id AND t.tx_hash = p_hash
          )
        )
    AND v.status IN ('published', 'revoked', 'superseded')
    AND v.public_projection IS NOT NULL
  ORDER BY e.public_key, v.version DESC
  LIMIT 50
$$;

REVOKE EXECUTE ON FUNCTION core.public_hash_lookup(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_hash_lookup(TEXT) TO mpc_app;
