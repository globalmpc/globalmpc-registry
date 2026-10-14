-- Outbox delivery state — spec 07 §7.5, 06 §6.3.
--
-- **Decision: the consumer lives in the database, not in a second queue.**
--
-- ADR-T10 named pg-boss as the publish target. pg-boss would keep a second copy of every event
-- in its own schema, owned by a role that can create schemas — a role no deployment has — while
-- every consumer so far runs inside the outbox worker against this same database. The outbox
-- table already gives what the queue would: durable rows, written in the domain transaction,
-- read at least once. What was missing is the part §7.5 names beyond that: retry, dead-letter,
-- an operator-visible count, and replay. Those columns are added here. A broker can still be
-- attached later as one more handler without changing this contract.
--
-- **A dead-lettered event is not published.** `published_at` stays empty so "delivered" never
-- appears for something no handler finished. `dead_lettered_at` separates it from the ordinary
-- backlog, which is still being retried.

ALTER TABLE core.outbox
  ADD COLUMN attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Retrying at once keeps hammering a handler that is down. Empty means "due now".
  ADD COLUMN next_attempt_at  TIMESTAMPTZ,
  -- Error category and message only. Payloads never go here — it is shown on the ops screen.
  ADD COLUMN last_error       TEXT,
  ADD COLUMN dead_lettered_at TIMESTAMPTZ,
  -- Replay may exclude handlers by side effect (07 §7.5 "disable option"). The exclusion is
  -- stored on the row so it holds until the replayed event is delivered, whichever process
  -- picks it up.
  ADD COLUMN skip_handlers    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN replayed_at      TIMESTAMPTZ;

-- The publisher reads only due, live rows. The old index also covered dead-lettered rows.
CREATE INDEX outbox_due_idx ON core.outbox (occurred_at, id)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX outbox_dead_letter_idx ON core.outbox (dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;

-- The anchor worker changes chain state, and those changes now emit events (0066) inside the
-- same transaction. The events carry chain facts only; the worker still has no write access
-- to domain tables.
GRANT INSERT ON core.outbox TO mpc_worker;

-- Consumer deduplication — (event id, handler version).
GRANT SELECT, INSERT ON core.inbox TO mpc_worker;

-- Replay is an operator act run with the worker's connection. It is recorded in the audit log
-- like any other state change; the worker still cannot read or change existing audit rows.
GRANT INSERT ON audit.events TO mpc_worker;
GRANT USAGE ON SEQUENCE audit.events_id_seq TO mpc_worker;
