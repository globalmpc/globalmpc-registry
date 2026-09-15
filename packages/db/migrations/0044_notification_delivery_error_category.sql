-- Notification delivery errors are stored as a category — W-087.
--
-- `last_error` held the peer's answer verbatim ("HTTP 404", connection error text, the secret
-- file path that failed to resolve) and the admin screen shows it. With an operator-set URL
-- that is a probing oracle: register an internal address, read back what it answered. The
-- worker now writes one of a fixed set of categories; this constraint makes any other value
-- impossible, whatever writes the row.
--
-- Existing values are mapped first so the constraint can be added on a database that already
-- delivered. The mapping only needs to be coarse — the original text is what is being removed.

UPDATE core.notification_deliveries
SET last_error = CASE
  WHEN last_error LIKE 'Could not resolve secret reference%' THEN 'secret_unavailable'
  WHEN last_error LIKE 'HTTP %' THEN 'http_error'
  WHEN last_error ILIKE '%abort%' THEN 'timeout'
  ELSE 'network_error'
END
WHERE last_error IS NOT NULL
  AND last_error NOT IN (
    'rejected_destination', 'secret_unavailable', 'http_error',
    'timeout', 'network_error', 'response_too_large'
  );

ALTER TABLE core.notification_deliveries
  ADD CONSTRAINT notification_deliveries_last_error_category CHECK (
    last_error IS NULL OR last_error IN (
      'rejected_destination', 'secret_unavailable', 'http_error',
      'timeout', 'network_error', 'response_too_large'
    )
  );
