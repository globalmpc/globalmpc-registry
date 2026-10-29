-- The anchor wallet's daily spend cap (O1) counts the L1 data fee on OP-stack chains.
--
-- On opBNB a transaction pays `gasUsed × effectiveGasPrice` for execution and, separately, an
-- L1 data fee for posting it to BSC — the receipt's `l1Fee`. It follows BSC's gas price, so no
-- L2 fee cap bounds it, and an L1 spike can make it the larger part. Both ledgers held only the
-- execution part, so the cap undercounted every opBNB send: spent receipts (`chain.gas_spend`)
-- and the reservation for sends still in flight (`chain.anchor_sends`, gas limit × max fee).
--
-- - `chain.gas_spend.l1_fee` — the receipt's actual L1 data fee. The cap sums
--   `gas_used × effective_gas_price + l1_fee`.
-- - `chain.anchor_sends.l1_fee_bound` — the L1 data fee reserved for a send until it settles:
--   the GasPriceOracle quote for the signed transaction with a margin. Not a ceiling the
--   transaction signs, unlike gas limit × max fee; the receipt's `l1_fee` replaces it.
--
-- Both default to 0, which is exact for rows on chains without an L1 data fee (31337, 56). An
-- opBNB row written before this release keeps the undercount it already had; spent rows leave the
-- cap at the next UTC day, and an open send's reservation ends at its receipt. Grants
-- are unchanged: the worker's table-level INSERT covers the new columns, and neither is in its
-- column-level UPDATE on `chain.anchor_sends` — what was reserved is not rewritten.

ALTER TABLE chain.gas_spend
  ADD COLUMN l1_fee NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (l1_fee >= 0);

ALTER TABLE chain.anchor_sends
  ADD COLUMN l1_fee_bound NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (l1_fee_bound >= 0);
