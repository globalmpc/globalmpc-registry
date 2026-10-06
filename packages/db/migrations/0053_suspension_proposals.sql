-- Suspension proposals when evidence is shaken — spec 05 §5.5 steps 5-6, 04 §4.3, AC-04.
--
-- 05 §5.5 ends the propagation with two steps nothing performed: propose a lifecycle suspension,
-- and tell the people responsible, the Issuer among them. 04 §4.3 lists "required evidence
-- downgrade" as a reason to suspend. Until now the chain stopped at signals for data stewards;
-- the people who can suspend a project learned about it only by opening the right screen.
--
-- **A proposal, never a transition.** Lifecycle has no automatic transitions (lifecycle route):
-- a person records who and why. Suspending on every stale attestation would turn a source outage
-- into a halted project, the same reason public records are not taken down automatically (0024).
-- Whether a given downgrade is blocking depends on the readiness policy; no rule for that has been
-- decided, so the proposal is raised for every shaken attestation and a person judges it.
--
-- Stored as an evidence signal with its own target type, so it appears where open signals already
-- appear (the project's signal list and the unassigned work list) and closes the same way, with a
-- recorded reason.

ALTER TYPE core.stale_signal_target ADD VALUE IF NOT EXISTS 'project_lifecycle';

/**
 * attestation → suspension proposal.
 *
 * Only for projects in a state that can be suspended (`any eligible state → suspended`, 04 §4.3):
 * a draft has nothing to suspend, a retired project has ended, and a suspended one already is.
 *
 * **One open proposal per project.** A dropped connection can move dozens of attestations at
 * once; one proposal each would bury the decision under copies of itself. Later causes are still
 * visible through the attestation signals 0024 leaves.
 */
CREATE OR REPLACE FUNCTION core.propose_project_suspension() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_project UUID;
  target_state core.at_lifecycle_state;
BEGIN
  IF NEW.state <> 'stale_candidate' OR OLD.state = 'stale_candidate' THEN
    RETURN NEW;
  END IF;

  SELECT p.id, p.lifecycle_state INTO target_project, target_state
  FROM core.verification_cases c
  JOIN core.projects p ON p.id = c.project_id
  WHERE c.id = NEW.case_id;

  IF target_project IS NULL
     OR target_state NOT IN ('registered', 'offering_open', 'offering_closed', 'active',
                             'branch_vote', 'continuing', 'divested', 'closure')
  THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.evidence_stale_signals (
    id, tenant_id, project_id, target_type, target_id, origin_attestation_id, reason
  )
  SELECT gen_random_uuid(), NEW.tenant_id, target_project, 'project_lifecycle', target_project,
         NEW.id,
         format('Evidence behind this %s project was shaken; consider suspending it. '
                'Nothing is suspended automatically. Cause: %s',
                target_state, coalesce(NEW.stale_reason, 'attestation needs re-review'))
  WHERE NOT EXISTS (
    SELECT 1 FROM core.evidence_stale_signals s
    WHERE s.target_type = 'project_lifecycle'
      AND s.target_id = target_project
      AND s.resolution = 'open'
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$$;

CREATE TRIGGER attestations_propose_suspension
  AFTER UPDATE ON core.verification_attestations
  FOR EACH ROW EXECUTE FUNCTION core.propose_project_suspension();

/**
 * stale signal → notification, routed by what the signal is about.
 *
 * Redefined from 0030. Evidence signals still go to `data_steward`, who fills the evidence. A
 * suspension proposal goes to `issuer_officer` (05 §5.5 step 6): the Issuer answers for the
 * project and holds `project.lifecycle.suspend`. Sending it to stewards would put the decision
 * with people who cannot make it.
 */
CREATE OR REPLACE FUNCTION core.notify_evidence_stale() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_type = 'project_lifecycle' THEN
    INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
    VALUES (
      NEW.tenant_id, 'evidence_stale', 'issuer_officer', NEW.project_id,
      'Suspension to consider: ' || NEW.reason,
      '/w/projects/' || NEW.project_id
    );
    RETURN NEW;
  END IF;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'evidence_stale', 'data_steward', NEW.project_id,
    'Evidence became stale: ' || NEW.reason,
    '/w/work'
  );
  RETURN NEW;
END;
$$;
