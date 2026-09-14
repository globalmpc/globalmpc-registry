-- Source Adapter call settings — spec 05 §5.12, OD-42.
--
-- `source_connections` held only `secret_reference` until now. Even with access
-- secured, **there was nowhere to store where to send requests.**
--
-- The principle of storing only a **reference**, not the value, is unchanged. Endpoint and timeout
-- are not secrets, so they live here; tokens·keys stay only where `secret_reference` points.

ALTER TABLE core.source_connections
  -- Call target. Only https is allowed, and credentials (`user:pass@`) inside the URL are
  -- blocked. Requests to a registry must not go out in plaintext, and a secret in a URL
  -- ends up verbatim in logs·audit·error messages.
  ADD COLUMN endpoint TEXT
    CHECK (endpoint ~ '^https://[^@[:space:]]+$'),

  -- Without it, the call waits indefinitely. One stalled source stalls all collection.
  ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 10000
    CHECK (timeout_ms BETWEEN 1000 AND 60000),

  -- Field name for extracting the as-of date from the response. Without it the as-of date is
  -- unknown, and it is not filled in with the lookup time instead.
  ADD COLUMN effective_at_field TEXT,

  -- Recorded verbatim in the receipt. It answers "what was it read with at the time" later.
  ADD COLUMN adapter_version TEXT NOT NULL DEFAULT 'v0',
  ADD COLUMN source_schema_version TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN authentication_method TEXT NOT NULL DEFAULT 'none',

  -- Terms of use. Whether a source permits reuse varies by institution; if unknown it is
  -- `unconfirmed`. Reading unknown as permitted is a contract violation.
  ADD COLUMN terms_license TEXT NOT NULL DEFAULT 'unconfirmed',
  ADD COLUMN commercial_reuse TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (commercial_reuse IN ('confirmed', 'unconfirmed', 'prohibited')),
  ADD COLUMN disclosure_permission core.sensitivity NOT NULL DEFAULT 'restricted';

/**
 * Demote existing false `active` rows.
 *
 * While the endpoint column did not exist, an `authenticated_api` connection could be `active`
 * with no call target. That is not a connection but a **label saying connected**. Before adding
 * the constraint below, restore the state to match the facts.
 *
 * Demote to `access_confirmed` — this does not deny the access agreement itself; it means
 * there is no automated call path, and an adapter in that state reads as `manual`.
 */
UPDATE core.source_connections
SET state = 'access_confirmed'
WHERE state = 'active'
  AND collection_method = 'authenticated_api'
  AND endpoint IS NULL;

/**
 * An `active` connection cannot lack a call target.
 *
 * Without this constraint a connection with no endpoint could be raised to `active`, and the UI would
 * show it as "connected" — the unverified-integration overstatement R5 prevents would start in the DB.
 *
 * Non-API collection methods (manual check·signed documents) normally have no endpoint.
 * Those do not call an adapter.
 */
ALTER TABLE core.source_connections
  ADD CONSTRAINT source_connections_active_needs_endpoint
  CHECK (
    state <> 'active'
    OR collection_method <> 'authenticated_api'
    OR endpoint IS NOT NULL
  );
