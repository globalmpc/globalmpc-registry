-- No offering-family lifecycle state without the offering conditions — spec 04 §4.3,
-- invariant 7, OD-07.
--
-- The lifecycle route now refuses `registered → offering_open` unless every offering
-- precondition is confirmed with evidence and a person decided `go` on the offering gate.
-- A route check alone can be bypassed by a migration script, an ops console, or a future route
-- that forgets to call it (0003). This trigger makes the same rule hold for every writer.
--
-- **Scope.** It covers entering `offering_open` and every state that exists only after an
-- offering opened. Entering one of them — from any state, including reinstatement from
-- `suspended` — re-checks the conditions, so a condition that lapsed cannot be carried
-- forward. `draft`, `registered`, `suspended`, `closure` and `retired` are not offering states
-- and are left to the route.
--
-- **The precondition keys are listed here as well as in `packages/domain/src/offering-gate.ts`.**
-- A test inserts exactly the domain list and expects this trigger to pass, so the two cannot
-- drift apart silently.
--
-- **The go decision is the latest one.** A `hold` or `stop` recorded after a `go` withdraws it;
-- looking for "any go ever" would let a withdrawn approval open an offering.

CREATE OR REPLACE FUNCTION core.guard_offering_lifecycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  evidenced_count INTEGER;
  latest_decision core.gate_decision_value;
BEGIN
  IF NEW.lifecycle_state NOT IN (
    'offering_open', 'offering_closed', 'active', 'branch_vote', 'continuing', 'divested'
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.lifecycle_state = NEW.lifecycle_state THEN
    RETURN NEW;
  END IF;

  SELECT count(DISTINCT fact_key) INTO evidenced_count
  FROM core.project_facts
  WHERE project_id = NEW.id
    AND status = 'confirmed'
    AND evidence_ref IS NOT NULL
    AND fact_key IN (
      'issuer_identified',
      'host_country_spv',
      'jurisdiction_determined',
      'ersp_engaged',
      'legal_issuance_decision',
      'security_audit',
      'separate_implementation_plan'
    );

  IF evidenced_count < 7 THEN
    RAISE EXCEPTION
      'Lifecycle state % requires every offering precondition confirmed with evidence (% of 7)',
      NEW.lifecycle_state, evidenced_count
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT decision INTO latest_decision
  FROM core.gate_decisions
  WHERE project_id = NEW.id AND gate_id = 'offering_activation'
  ORDER BY signed_at DESC, created_at DESC
  LIMIT 1;

  IF latest_decision IS DISTINCT FROM 'go' THEN
    RAISE EXCEPTION
      'Lifecycle state % requires a go decision on the offering gate (latest: %)',
      NEW.lifecycle_state, coalesce(latest_decision::text, 'none')
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER projects_offering_lifecycle_guard
  BEFORE INSERT OR UPDATE OF lifecycle_state ON core.projects
  FOR EACH ROW EXECUTE FUNCTION core.guard_offering_lifecycle();
