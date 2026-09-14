-- The 0038 constraints did not actually block — 2026-09-10.
--
-- `jsonb ->> 'key'` yields **NULL** when the key is missing. And `NULL = 'server_adapter'` is
-- NULL, not FALSE. **A CHECK constraint does not treat NULL as a violation** — not-true
-- and false differ in SQL.
--
-- So `api_confirmation_requires_server_collection` let through an INSERT with an empty
-- `channel_evidence`. The constraint built to block exactly that case
-- did not block it.
--
-- The other two were caught **by accident** thanks to the adjacent `AND channel_evidence ? '...'`
-- (`NULL AND FALSE` is FALSE). With all keys present and only `verifiedBy` missing,
-- the same hole opens. All three are fixed together.
--
-- **A test that attempts an INSERT bypassing the route caught this.** Had the constraint been
-- left as "added, so it blocks", this would not have surfaced — the first version of 0038 was
-- committed in that state.
--
-- Why a new file instead of fixing 0038: migrations are pinned by their checksum at apply
-- time (`runMigrations`). Editing an already-applied file makes that environment get rejected
-- at startup. Instead of erasing the mistake, **the fix is recorded.**

ALTER TABLE core.source_receipts
  DROP CONSTRAINT IF EXISTS signed_document_confirmation_is_server_bound,
  DROP CONSTRAINT IF EXISTS bulk_export_confirmation_is_server_bound,
  DROP CONSTRAINT IF EXISTS api_confirmation_requires_server_collection;

/**
 * Keeps comparisons from leaking into NULL.
 *
 * `coalesce(..., '')` turns "key missing" into an empty string, and the empty string equals no
 * expected value — so the result is FALSE and the constraint actually fires.
 */
ALTER TABLE core.source_receipts
  ADD CONSTRAINT signed_document_confirmation_is_server_bound
  CHECK (
    collection_method <> 'verifiable_signed_document'
    OR result <> 'confirmed_from_source'
    OR (
      coalesce(channel_evidence ->> 'verifiedBy', '') = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'verifierVersion'
      AND coalesce(channel_evidence ->> 'signerRecognized', '') = 'true'
    )
  ) NOT VALID;

ALTER TABLE core.source_receipts
  ADD CONSTRAINT bulk_export_confirmation_is_server_bound
  CHECK (
    collection_method <> 'official_bulk_export'
    OR result <> 'confirmed_from_source'
    OR (
      coalesce(channel_evidence ->> 'verifiedBy', '') = 'server'
      AND channel_evidence ? 'documentHash'
      AND channel_evidence ? 'extractorVersion'
      AND channel_evidence ? 'observedFields'
    )
  ) NOT VALID;

ALTER TABLE core.source_receipts
  ADD CONSTRAINT api_confirmation_requires_server_collection
  CHECK (
    collection_method <> 'authenticated_api'
    OR result <> 'confirmed_from_source'
    OR coalesce(channel_evidence ->> 'collector', '') = 'server_adapter'
  ) NOT VALID;
