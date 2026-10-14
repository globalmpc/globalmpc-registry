-- Material-information blackout — spec 07 §7.14, 03 J-22, AC-30.
--
-- `core.disclosure_restrictions` existed since 0001 with no route writing it, so a blackout
-- could only be a row someone inserted by hand. The table also lacked what §7.14 requires a
-- restriction to carry: the material-information reference, the expected next update and
-- release time, who activated it, and the signed release record.
--
-- This migration adds those, fixes the transition rules in the DB, and keeps an append-only
-- history of every activation, blocked attempt, release, and supersession (J-22 step 5: none
-- of it is deleted).

ALTER TABLE core.disclosure_restrictions
  -- Which material information this blackout protects. A reference, not the content — the
  -- content stays private until it is disclosed.
  ADD COLUMN material_info_ref TEXT,
  -- Why the action is restricted, in words shown next to the blocked action (11 §11.12).
  ADD COLUMN reason TEXT,
  ADD COLUMN expected_next_update_at TIMESTAMPTZ,
  ADD COLUMN expected_release_at TIMESTAMPTZ,
  ADD COLUMN created_by UUID REFERENCES core.subjects(id),
  ADD COLUMN activated_by UUID REFERENCES core.subjects(id),
  ADD COLUMN released_by UUID REFERENCES core.subjects(id),
  /**
   * The release record — J-22 step 4.
   *
   * Disclosure completion reference, legal condition, and the reason, as the releasing person
   * recorded them. A blackout without this record cannot be `released`: the check below makes
   * "it lifted on its own" impossible to store.
   */
  ADD COLUMN release_record JSONB,
  ADD COLUMN superseded_by_id UUID,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

/**
 * NOT VALID: rows inserted by hand before this migration have no release record. They are left
 * as they are rather than given an invented one; every new write is checked.
 */
ALTER TABLE core.disclosure_restrictions
  ADD CONSTRAINT disclosure_restrictions_release_needs_record CHECK (
    state <> 'released'
    OR (released_by IS NOT NULL AND release_record IS NOT NULL AND released_at IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT disclosure_restrictions_active_needs_start CHECK (
    state <> 'active' OR effective_at IS NOT NULL
  ) NOT VALID;

-- Composite key for tenant-scoped references (same pattern as 0006). RLS does not cover FKs.
ALTER TABLE core.disclosure_restrictions
  ADD CONSTRAINT disclosure_restrictions_tenant_scope_key UNIQUE (tenant_id, id);

ALTER TABLE core.disclosure_restrictions
  ADD CONSTRAINT disclosure_restrictions_superseded_by_same_tenant
    FOREIGN KEY (tenant_id, superseded_by_id)
    REFERENCES core.disclosure_restrictions (tenant_id, id);

CREATE INDEX disclosure_restrictions_active_idx
  ON core.disclosure_restrictions (project_id) WHERE state = 'active';

/**
 * Transition and content guard.
 *
 * The transition table mirrors `disclosureRestrictionMachine` in `@mpc/domain`. The API checks
 * it first and answers 422; this trigger is what holds when something bypasses the API.
 *
 * Once a restriction leaves `draft`, what it restricts no longer changes. Widening or narrowing
 * the scope of a live blackout in place would leave no record of what was blocked when — a
 * change is a new restriction that supersedes this one.
 */
CREATE OR REPLACE FUNCTION core.guard_disclosure_restriction() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'draft'  AND NEW.state IN ('active', 'superseded'))
    OR (OLD.state = 'active' AND NEW.state IN ('released', 'superseded'))
  ) THEN
    RAISE EXCEPTION 'disclosure restriction transition % -> % is not allowed', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state <> 'draft' AND (
       NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.subject_scope IS DISTINCT FROM OLD.subject_scope
    OR NEW.restricted_action_types IS DISTINCT FROM OLD.restricted_action_types
    OR NEW.legal_basis IS DISTINCT FROM OLD.legal_basis
    OR NEW.authority IS DISTINCT FROM OLD.authority
    OR NEW.material_info_ref IS DISTINCT FROM OLD.material_info_ref
  ) THEN
    RAISE EXCEPTION 'the scope of a disclosure restriction cannot change after it leaves draft'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER disclosure_restrictions_guard
  BEFORE UPDATE ON core.disclosure_restrictions
  FOR EACH ROW EXECUTE FUNCTION core.guard_disclosure_restriction();

CREATE TRIGGER disclosure_restrictions_no_delete
  BEFORE DELETE ON core.disclosure_restrictions
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- ---------------------------------------------------------------------------
-- History — activation, blocked attempts, release, supersession (J-22 step 5)
-- ---------------------------------------------------------------------------

CREATE TABLE core.disclosure_restriction_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  restriction_id   UUID NOT NULL,
  project_id       UUID NOT NULL,
  event_kind       TEXT NOT NULL
                     CHECK (event_kind IN ('created', 'activated', 'blocked_attempt',
                                           'released', 'superseded')),
  -- For `blocked_attempt`: which action was refused.
  action_type      TEXT,
  actor_subject_id UUID REFERENCES core.subjects(id),
  reason           TEXT,
  correlation_id   TEXT,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT disclosure_restriction_events_blocked_names_action CHECK (
    event_kind <> 'blocked_attempt' OR action_type IS NOT NULL
  ),
  FOREIGN KEY (tenant_id, restriction_id) REFERENCES core.disclosure_restrictions (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

CREATE INDEX disclosure_restriction_events_restriction_idx
  ON core.disclosure_restriction_events (restriction_id, occurred_at);

CREATE OR REPLACE FUNCTION core.reject_disclosure_event_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Blackout history cannot be modified or deleted'
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER disclosure_restriction_events_append_only
  BEFORE UPDATE OR DELETE ON core.disclosure_restriction_events
  FOR EACH ROW EXECUTE FUNCTION core.reject_disclosure_event_mutation();

ALTER TABLE core.disclosure_restriction_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.disclosure_restriction_events FORCE ROW LEVEL SECURITY;

CREATE POLICY disclosure_restriction_events_tenant ON core.disclosure_restriction_events FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.disclosure_restriction_events TO mpc_app;
