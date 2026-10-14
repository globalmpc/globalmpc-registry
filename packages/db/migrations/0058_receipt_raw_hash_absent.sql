-- A missing original is recorded as missing — REQ-DAPP-049.
--
-- **Why:** `source_receipts.raw_hash` was NOT NULL, so a lookup that returned nothing (source
-- unavailable, authentication failed) had to write *some* hash. The adapter wrote 32 zero bytes
-- and the Data Room wrote a fixed `0xabab…`. Both look like a hash of an original that does not
-- exist, and "re-fetch the original for this hash and compare" then fails in a way nobody can
-- explain.
--
-- Now: NULL means "no original was received". A zero hash is refused for new rows. NOT VALID
-- because receipts are append-only (an UPDATE trigger rejects changes) and rows written before
-- this migration keep what they recorded.

ALTER TABLE core.source_receipts
  ALTER COLUMN raw_hash DROP NOT NULL,
  ADD CONSTRAINT source_receipts_raw_hash_not_zero
    CHECK (raw_hash IS NULL OR raw_hash <> '0x0000000000000000000000000000000000000000000000000000000000000000')
    NOT VALID;
