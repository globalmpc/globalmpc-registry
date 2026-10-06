-- The application can release an unsettled idempotency reservation.
--
-- Source lookup reserves a key before calling out and releases it when the call or the
-- following write fails (`releaseIdempotency`). The release is a DELETE, and 0002 granted the
-- application role only SELECT, INSERT and UPDATE on tenant tables. So the release itself failed
-- with a permission error: the client saw that error instead of the real failure, and the key
-- stayed in flight, so every retry was answered "in progress".
--
-- DELETE is granted on this one table only. A restrictive policy narrows it to reservations that
-- never received a response — a settled response is what makes retries safe, and removing it
-- would let a retry repeat the side effect.

GRANT DELETE ON core.idempotency_keys TO mpc_app;

CREATE POLICY release_unsettled_only ON core.idempotency_keys
  AS RESTRICTIVE
  FOR DELETE
  USING (response_snapshot IS NULL);
