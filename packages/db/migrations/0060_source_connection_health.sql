-- Source connection health and stage evidence — spec 04 §4.9, 12 §12.13 (R5 gate item 8), AC-19.
--
-- Two gaps closed here:
--
-- 1. **A degrading source result changed nothing.** `SOURCE_RESULT_BEHAVIOUR.degradesConnection`
--    existed in `@mpc/domain`, but no code read it. A connection kept answering `schema_changed`
--    and stayed `active`, collection kept running, and nobody was asked to reconcile. AC-19
--    requires degradation, an ingestion pause, and a reconciliation task.
-- 2. **The integration stage had no evidence.** `source_connections.state` already holds
--    `planned|feasibility_checked|access_confirmed|tested|active`, but only the current value.
--    The R5 gate asks for evidence of each stage — when it was reached, by whom, and why.

-- ---------------------------------------------------------------------------
-- Which results degrade a connection
-- ---------------------------------------------------------------------------

/**
 * Mirrors `SOURCE_RESULT_BEHAVIOUR[result].degradesConnection` in `@mpc/domain`.
 *
 * Kept in SQL because the rule has to hold on every insert path — the adapter route, the manual
 * receipt route, and anything that writes receipts later. A test compares all 12 values with
 * the domain table.
 */
CREATE OR REPLACE FUNCTION core.source_result_degrades_connection(result core.source_result)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT result IN (
    'access_not_authorized',
    'source_unavailable',
    'authentication_failed',
    'signature_invalid',
    'schema_changed'
  );
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation tasks
-- ---------------------------------------------------------------------------

/**
 * One open task per degraded connection — the adapter-health `reconciliation_required` signal.
 *
 * A task is what makes the pause end deliberately. Without it, a degraded connection is either
 * stuck forever or brought back by whoever flips the state, with no record of what was checked.
 */
CREATE TABLE core.source_reconciliation_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  connection_id   UUID NOT NULL,
  -- The receipt whose result opened the task. The raw hash and versions it kept are what the
  -- reconciler compares against.
  receipt_id      UUID NOT NULL,
  trigger_result  core.source_result NOT NULL,
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES core.subjects(id),
  resolution      TEXT,
  version         INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT source_reconciliation_resolution_recorded CHECK (
    state <> 'resolved'
    OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL
        AND resolution IS NOT NULL AND length(btrim(resolution)) > 0)
  ),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES core.source_connections (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES core.source_receipts (tenant_id, id)
);

CREATE UNIQUE INDEX source_reconciliation_one_open_per_connection
  ON core.source_reconciliation_tasks (connection_id) WHERE state = 'open';

/** `resolved` is terminal, and what opened the task does not change. */
CREATE OR REPLACE FUNCTION core.guard_source_reconciliation_task() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'resolved'
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
     OR NEW.trigger_result IS DISTINCT FROM OLD.trigger_result THEN
    RAISE EXCEPTION 'a resolved reconciliation task, or what opened it, cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER source_reconciliation_tasks_guard
  BEFORE UPDATE ON core.source_reconciliation_tasks
  FOR EACH ROW EXECUTE FUNCTION core.guard_source_reconciliation_task();

CREATE TRIGGER source_reconciliation_tasks_no_delete
  BEFORE DELETE ON core.source_reconciliation_tasks
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

ALTER TABLE core.source_reconciliation_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.source_reconciliation_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY source_reconciliation_tasks_tenant ON core.source_reconciliation_tasks FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.source_reconciliation_tasks TO mpc_app;

-- ---------------------------------------------------------------------------
-- Degrade on receipt — AC-19
-- ---------------------------------------------------------------------------

/**
 * A degrading result takes an `active` connection to `degraded` and opens a task.
 *
 * `degraded` is read as `blocked` by `connectionStateToAdapterState`, so collection stops at the
 * callability check — that is the ingestion pause. Only `active` moves: the connection machine
 * allows `active → degraded` and nothing else into `degraded`, and a connection that is not
 * active has no automatic ingestion to pause.
 *
 * The version is bumped. A client holding the old version must reread before changing the
 * connection, or it would overwrite the degradation it never saw.
 */
CREATE OR REPLACE FUNCTION core.degrade_connection_on_receipt() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT core.source_result_degrades_connection(NEW.result) THEN
    RETURN NEW;
  END IF;

  PERFORM set_config(
    'app.connection_transition_reason',
    format('Source result %s recorded (receipt %s)', NEW.result, NEW.id),
    true
  );

  UPDATE core.source_connections
  SET state = 'degraded', version = version + 1
  WHERE id = NEW.connection_id AND state = 'active';

  IF FOUND THEN
    INSERT INTO core.source_reconciliation_tasks (tenant_id, connection_id, receipt_id, trigger_result)
    VALUES (NEW.tenant_id, NEW.connection_id, NEW.id, NEW.result)
    ON CONFLICT (connection_id) WHERE state = 'open' DO NOTHING;
  END IF;

  PERFORM set_config('app.connection_transition_reason', '', true);
  RETURN NEW;
END
$$;

CREATE TRIGGER source_receipts_degrade_connection
  AFTER INSERT ON core.source_receipts
  FOR EACH ROW EXECUTE FUNCTION core.degrade_connection_on_receipt();

-- ---------------------------------------------------------------------------
-- Stage evidence — R5 gate item 8
-- ---------------------------------------------------------------------------

CREATE TABLE core.source_connection_transitions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  connection_id    UUID NOT NULL,
  -- NULL on the row that records the state a connection was created in.
  from_state       core.source_connection_state,
  to_state         core.source_connection_state NOT NULL,
  actor_subject_id UUID REFERENCES core.subjects(id),
  reason           TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, connection_id) REFERENCES core.source_connections (tenant_id, id)
);

CREATE INDEX source_connection_transitions_connection_idx
  ON core.source_connection_transitions (connection_id, occurred_at);

CREATE OR REPLACE FUNCTION core.reject_connection_transition_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Connection stage history cannot be modified or deleted'
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER source_connection_transitions_append_only
  BEFORE UPDATE OR DELETE ON core.source_connection_transitions
  FOR EACH ROW EXECUTE FUNCTION core.reject_connection_transition_mutation();

ALTER TABLE core.source_connection_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.source_connection_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY source_connection_transitions_tenant ON core.source_connection_transitions FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.source_connection_transitions TO mpc_app;

/**
 * Records every state change, whoever made it.
 *
 * A trigger rather than the route: connections also change state from other triggers
 * (authority approval withdrawn, a degrading receipt). History written only by the API would
 * miss exactly the changes nobody asked for.
 *
 * The API passes the reason and actor through transaction-local settings. A change that
 * arrives without them says so instead of inventing a reason.
 */
CREATE OR REPLACE FUNCTION core.record_connection_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  reason TEXT := NULLIF(current_setting('app.connection_transition_reason', true), '');
  actor  UUID := NULLIF(current_setting('app.actor_subject_id', true), '')::UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.source_connection_transitions (
    tenant_id, connection_id, from_state, to_state, actor_subject_id, reason
  ) VALUES (
    NEW.tenant_id, NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END,
    NEW.state, actor,
    COALESCE(reason, 'Changed outside an API request (for example, authority approval withdrawn)')
  );

  RETURN NEW;
END
$$;

CREATE TRIGGER source_connections_record_transition
  AFTER INSERT OR UPDATE OF state ON core.source_connections
  FOR EACH ROW EXECUTE FUNCTION core.record_connection_transition();

/**
 * Existing connections get one row for the state they are in now.
 *
 * Earlier stages were not recorded, and they are not reconstructed — a guessed history would be
 * exactly the unverified claim the R5 gate forbids.
 */
INSERT INTO core.source_connection_transitions (tenant_id, connection_id, from_state, to_state, reason)
SELECT tenant_id, id, NULL, state,
       'Stage recorded when stage history began; earlier stages were not recorded'
FROM core.source_connections;
