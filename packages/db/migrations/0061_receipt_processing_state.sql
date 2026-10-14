-- Source Receipt processing state — spec 04 §4.9 (Source Receipt lifecycle), 07 §7.13.
--
-- `receiptProcessingMachine` in `@mpc/domain` defines how far a response got through the
-- pipeline (`requested → received → … → classified | quarantined`), orthogonal to what the source
-- said. No column held it, so a `schema_changed` receipt — whose body was never normalized — sat
-- next to a `confirmed_from_source` one with nothing saying its values must not be read.
--
-- What is recorded is the state the receipt reached when it was stored:
--
-- - `quarantined` for `schema_changed` and `signature_invalid`. The response arrived but was not
--   trusted enough to normalize (§7.13: unknown schema is quarantined).
-- - `classified` for every other result.
--
-- The server sets it; an insert cannot claim another value. The intermediate states run inside
-- one request and are not stored separately, and `reconciled` is not written back: receipts are
-- append-only (0003), so the reconciliation outcome lives on `source_reconciliation_tasks`.
--
-- Rows stored before this migration stay NULL — "not recorded", not a guessed value.

ALTER TABLE core.source_receipts
  ADD COLUMN processing_state TEXT
    CHECK (processing_state IN (
      'requested', 'received', 'authenticated', 'schema_validated',
      'normalized', 'classified', 'reconciled', 'quarantined'
    ));

/** Mirrors `receiptProcessingStateFor` in `@mpc/domain`. A test compares all 12 results. */
CREATE OR REPLACE FUNCTION core.receipt_processing_state_for(result core.source_result)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN result IN ('schema_changed', 'signature_invalid')
              THEN 'quarantined' ELSE 'classified' END;
$$;

CREATE OR REPLACE FUNCTION core.set_receipt_processing_state() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.processing_state := core.receipt_processing_state_for(NEW.result);
  RETURN NEW;
END
$$;

CREATE TRIGGER source_receipts_processing_state
  BEFORE INSERT ON core.source_receipts
  FOR EACH ROW EXECUTE FUNCTION core.set_receipt_processing_state();
