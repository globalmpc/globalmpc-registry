-- Project lifecycle transition history — spec 04 §4.3.
--
-- `core.projects.lifecycle_state` entered as `draft`, and a Registry publish moving it once to
-- `registered` was the only transition. The rest — suspension, reinstatement,
-- offering, closure — **had no path at all.** The R2 demo in 12 §12.4,
-- `evidence revoke → … → suspended → reinstatement`, did not run in the deployed build.
--
-- **Why a separate history table:** current state alone cannot tell "ended below quorum" from
-- "cancelled" — the same problem as governance_transitions in 0017.
-- A project reinstated from `suspended` and one that never stopped have the same current
-- state. Without telling them apart, an audit is impossible.

CREATE TABLE core.project_lifecycle_transitions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES core.tenants(id),
  project_id       UUID NOT NULL,
  from_state       core.at_lifecycle_state NOT NULL,
  to_state         core.at_lifecycle_state NOT NULL,
  -- A transition without a reason leaves nothing to judge later. Same as governance_transitions.
  reason           TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_subject_id UUID REFERENCES core.subjects(id),
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

CREATE INDEX project_lifecycle_transitions_project_idx
  ON core.project_lifecycle_transitions (project_id, occurred_at);

ALTER TABLE core.project_lifecycle_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_lifecycle_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY project_lifecycle_transitions_tenant ON core.project_lifecycle_transitions FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.project_lifecycle_transitions TO mpc_app;

/**
 * Who suspended it — the enforcement point for lifecycle decisions.
 *
 * Suspension is urgent, so **one person** does it. Requiring two means a problematic project
 * keeps running while waiting for the second person (same logic as wallet deactivation).
 *
 * In exchange, **the person who suspended cannot reinstate.** If one person could suspend and
 * revert, a single person could move the project state at will, and suspension would become
 * personal discretion rather than a control. This column is the basis for that check.
 */
ALTER TABLE core.projects
  ADD COLUMN suspended_by_subject_id UUID REFERENCES core.subjects(id);

/**
 * The history is **written explicitly by the route.** Not by a trigger.
 *
 * A trigger looks safer, but the two values this history needs — who and why — live in the
 * session, and a trigger does not know them. Pushing them through a session GUC obscures where
 * the values came from, and a path that forgot to set it is silently recorded as "the system moved it".
 *
 * Only two places write transitions — the Registry publish (`draft→registered`) and the lifecycle
 * transition route. Both write to this table explicitly.
 */
