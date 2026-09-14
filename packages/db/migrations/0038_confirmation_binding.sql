-- Confirmation binds only to server-produced evidence — 2026-09-10 audit A1.
--
-- 0021 added "confirmation requires signature evidence", but that evidence was **a boolean sent
-- in the request body**. A `source.upload` holder sending `signatureValid: true`
-- got `confirmed_from_source` as is. For bulk export,
-- `observedFields` was also written by the requester.
--
-- So the constraint existed, but what it required was **the presence of a claim**, not of a
-- verification. The three constraints below require **who produced the evidence**.
--
-- Routes block the same thing first (422 + nextAction). These exist because there is more than
-- one route and more will come — blocking in one place silently opens the moment a path that
-- bypasses it appears.
--
-- All are `NOT VALID`. `source_receipts` is append-only and a trigger rejects
-- UPDATE — by design there is no way to fix past receipts to the new rule. Receipts from before
-- the rule remain, and that is not hidden.

/**
 * Signed document — what was checked and under which rule is recorded together.
 *
 * Without `documentHash`, "re-fetch the original for this hash and compare" does not
 * hold; without `verifierVersion`, past confirmations cannot be reproduced after the
 * verification rule changes. `verifiedBy = 'server'` pins the subject that produced both.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT signed_document_confirmation_is_server_bound
  CHECK (
    collection_method <> 'verifiable_signed_document'
    OR result <> 'confirmed_from_source'
    OR (
      channel_evidence ->> 'verifiedBy' = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'verifierVersion'
      AND (channel_evidence ->> 'signerRecognized') = 'true'
    )
  ) NOT VALID;

/**
 * Bulk export — also requires the **fact that observed fields came from the file**.
 *
 * 0021 checked only that the `observedFields` key existed. The requester could fill that key.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT bulk_export_confirmation_is_server_bound
  CHECK (
    collection_method <> 'official_bulk_export'
    OR result <> 'confirmed_from_source'
    OR (
      channel_evidence ->> 'verifiedBy' = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'extractorVersion'
      AND channel_evidence ? 'observedFields'
    )
  ) NOT VALID;

/**
 * API collection — confirms only on the path where the server actually called the source.
 *
 * If this channel could be confirmed from an entry point where a person types in the result,
 * one could **record "called and confirmed" without calling.** That record is
 * indistinguishable from one produced by `/collect`.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT api_confirmation_requires_server_collection
  CHECK (
    collection_method <> 'authenticated_api'
    OR result <> 'confirmed_from_source'
    OR channel_evidence ->> 'collector' = 'server_adapter'
  ) NOT VALID;
