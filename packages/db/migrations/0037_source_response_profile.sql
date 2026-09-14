-- Source response profile — 2026-09-10 audit A7.
--
-- Until now the schema check for the `authenticated_api` channel was **successful JSON parsing**.
-- So an HTTP 200 carrying `{"error":"unavailable"}` or `{}` still
-- became `confirmed_from_source` — a path that records a source saying "cannot answer" as
-- a confirmation.
--
-- The other three channels already have something to check against: bulk export has
-- `schema_fingerprint`, signed document has the signature, manual has a second review. Only API lacked one.
--
-- **The connection holds the reference.** Code has no authorities (OD-43) — what counts as a
-- normal response differs per authority, and writing it in code would change the code every
-- time an authority is added.

ALTER TABLE core.source_connections
  /**
   * Top-level fields every normal response must have.
   *
   * Reuses `schema_fingerprint` — a new column would give bulk export and API
   * different answers to the same question. This comment records that reuse
   * and adds no column.
   */

  -- Field and value meaning "no record for that condition". `{"found": false}` gives
  -- ('found', 'false'). Some registries signal this with 200 rather than 404.
  ADD COLUMN response_record_absent_field TEXT,
  ADD COLUMN response_record_absent_value TEXT,
  -- Field carrying a business error inside a 200. If it has a value, it is not a success.
  ADD COLUMN response_business_error_field TEXT;

/**
 * The no-record check holds only when **both** field and value are set.
 *
 * With only one, the check silently turns off — that state reads not as an error but as "that
 * response is not a no-record", and the result tilts toward confirmation.
 */
ALTER TABLE core.source_connections
  ADD CONSTRAINT source_connection_record_absent_pair
  CHECK (
    (response_record_absent_field IS NULL) = (response_record_absent_value IS NULL)
  );
