-- Evidence channel parity — spec 05 §5.12, AC-29, OD-42.
--
-- All four channels pass through the same Source Receipt, but **each channel must block
-- something different.** The three named by AC-29:
--
--   1. an invalid signature on a signed document
--   2. schema drift in a bulk export
--   3. a missing second review on a manual confirmation
--
-- No per-channel tables. Those would split the result enum and the limitation notes, and
-- readers would have to interpret a fact differently depending on which path it came through.

ALTER TABLE core.source_connections
  -- Fields a bulk export must have. A mismatch with the observed fields is schema drift.
  -- Empty means no comparison — an unknown is never read as a match.
  ADD COLUMN schema_fingerprint TEXT[],
  -- Reference to the signed-document signer's public key. A reference, not the value.
  ADD COLUMN signing_key_reference TEXT;

ALTER TABLE core.source_receipts
  /**
   * Per-channel evidence.
   *
   * Signed document: signature and signer; bulk export: observed field list; manual: the
   * lookup path. **Why one column**: per-channel columns would change the schema with
   * every new channel, and code reading past receipts would have to determine the channel
   * first.
   */
  ADD COLUMN channel_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Who confirmed first. Compared against the second confirmer on the manual channel.
  ADD COLUMN first_confirmed_by  UUID REFERENCES core.subjects(id),
  ADD COLUMN second_confirmed_by UUID REFERENCES core.subjects(id),
  ADD COLUMN second_confirmed_at TIMESTAMPTZ,
  /**
   * The receipt a second review takes over.
   *
   * Receipts are append-only (`source_receipt_no_update`). A second review cannot edit the
   * existing row, so it **creates a new receipt that points to the earlier one.** Both
   * "seen by one person" and "seen by two people" stay on record.
   */
  ADD COLUMN supersedes_receipt_id UUID REFERENCES core.source_receipts(id);


/**
 * All constraints below are `NOT VALID`.
 *
 * `source_receipts` is append-only and a trigger rejects UPDATE, so there is **by design
 * no way** to bring past receipts in line with new rules. `NOT VALID` skips existing
 * rows and applies from new rows on — the only way to set a rule without rewriting
 * history.
 *
 * Receipts from before channel rules therefore remain. This is not hidden: an empty
 * `channel_evidence` is itself the record that "no comparison was made at the time".
 */

/**
 * The same person cannot confirm twice.
 *
 * A second review exists for a second pair of eyes. Allowing the same person leaves only the form.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT source_receipt_second_reviewer_differs
  CHECK (second_confirmed_by IS NULL OR second_confirmed_by IS DISTINCT FROM first_confirmed_by) NOT VALID;

/**
 * A manual confirmation cannot be finalized without a second review — AC-29.
 *
 * The manual path has no API response and no signature. One person's statement is the
 * only evidence, so if that alone could yield `confirmed_from_source`, **the weakest
 * channel would become the easiest one.**
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT manual_confirmation_needs_second_review
  CHECK (
    collection_method <> 'manual_official_registry_confirmation'
    OR result <> 'confirmed_from_source'
    OR second_confirmed_by IS NOT NULL
  ) NOT VALID;

/**
 * A signed document cannot be finalized without signature evidence — AC-29.
 *
 * A signed channel with no verification result means the signature was not checked.
 * An unchecked signature is the same as no signature.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT signed_document_needs_signature_evidence
  CHECK (
    collection_method <> 'verifiable_signed_document'
    OR result <> 'confirmed_from_source'
    OR (channel_evidence ? 'signatureValid' AND (channel_evidence ->> 'signatureValid') = 'true')
  ) NOT VALID;

/**
 * A bulk export cannot be finalized without an observed schema — AC-29.
 *
 * Judging drift requires a record of what was seen. Without it no comparison happened,
 * and a file with a changed schema was read as is.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT bulk_export_needs_observed_schema
  CHECK (
    collection_method <> 'official_bulk_export'
    OR result <> 'confirmed_from_source'
    OR channel_evidence ? 'observedFields'
  ) NOT VALID;
