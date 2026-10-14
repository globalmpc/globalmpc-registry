-- Break-glass elevation — spec 02 §2.6, §2.8; 13 §13.6 "admin JIT elevation expiry".
--
-- **Why:** during a security incident someone must be able to cut access at once. The standing
-- paths are deliberately slow — revoking a role takes two people and a proposal (0042). An
-- elevation is the narrow, time-boxed exception: it is itself approved by a second person, it
-- carries a purpose, a target and an expiry, and it only unlocks the emergency actions of
-- 02 §2.6 (the application lists them in `BREAK_GLASS_ACTIONS`). It can never touch evidence,
-- readiness, votes or entitlements — those actions do not list the `break_glass` role at all.
--
-- **Expiry is not a job.** Nothing flips a row to "expired". The session resolver only counts
-- an elevation while `now() < expires_at`, so an elevation stops working at its expiry even if
-- every worker is down. Relying on a sweeper would leave the privilege alive for as long as the
-- sweeper is late.
--
-- **The incident record is due within 24 hours of approval (02 §2.6).** An elevation whose
-- record is overdue stops granting, and while any elevation of the tenant is overdue no new one
-- can be requested — the exception cannot be used again until the last use is accounted for.
--
-- The "pre-approved security multisig" of 02 §2.6 is pending under OD-12. Until it is decided the
-- second approval is a different `security_operator` holder, the same two-person rule as role
-- grants.

CREATE TYPE core.break_glass_state AS ENUM ('pending', 'active', 'rejected', 'released');

CREATE TABLE core.break_glass_elevations (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants(id),
  -- Who is elevated. Always the requester: nobody elevates someone else.
  subject_id              UUID NOT NULL,
  purpose                 TEXT NOT NULL CHECK (length(btrim(purpose)) > 0),
  -- What the elevation is aimed at (a subject, a connection, a project). Free text on purpose:
  -- the incident decides the target, not a fixed list.
  target                  TEXT NOT NULL CHECK (length(btrim(target)) > 0),
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL,
  state                   core.break_glass_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id   UUID,
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT,
  -- Incident record (02 §2.6). Due 24 hours after approval.
  incident_reference      TEXT,
  incident_summary        TEXT,
  incident_recorded_by_subject_id UUID,
  incident_recorded_at    TIMESTAMPTZ,
  -- Release (02 §2.6: cause, recovery verification and approver are recorded).
  release_cause           TEXT,
  release_recovery_verification TEXT,
  released_by_subject_id  UUID,
  released_at             TIMESTAMPTZ,
  version                 INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT break_glass_expiry_after_request CHECK (expires_at > requested_at),
  -- Two-person rule, enforced here so no route can forget it.
  CONSTRAINT break_glass_two_person CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> subject_id
  ),
  -- The elevated person does not sign off their own release.
  CONSTRAINT break_glass_release_two_person CHECK (
    released_by_subject_id IS NULL OR released_by_subject_id <> subject_id
  ),
  CONSTRAINT break_glass_decision_shape CHECK (
    (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL)
    OR (state IN ('active', 'rejected', 'released')
        AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
        AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0)
  ),
  CONSTRAINT break_glass_release_shape CHECK (
    (state = 'released') = (released_at IS NOT NULL)
    AND (released_at IS NULL OR (
      released_by_subject_id IS NOT NULL
      AND length(btrim(coalesce(release_cause, ''))) > 0
      AND length(btrim(coalesce(release_recovery_verification, ''))) > 0
    ))
  ),
  CONSTRAINT break_glass_incident_shape CHECK (
    (incident_recorded_at IS NULL AND incident_reference IS NULL)
    OR (incident_recorded_at IS NOT NULL
        AND incident_recorded_by_subject_id IS NOT NULL
        AND length(btrim(coalesce(incident_reference, ''))) > 0
        AND length(btrim(coalesce(incident_summary, ''))) > 0)
  ),
  CONSTRAINT break_glass_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT break_glass_decider_same_tenant
    FOREIGN KEY (tenant_id, decided_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT break_glass_releaser_same_tenant
    FOREIGN KEY (tenant_id, released_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT break_glass_incident_recorder_same_tenant
    FOREIGN KEY (tenant_id, incident_recorded_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX break_glass_elevations_subject_idx
  ON core.break_glass_elevations (tenant_id, subject_id, state);

-- One open elevation per person. Two would blur which one an action ran under.
CREATE UNIQUE INDEX break_glass_elevations_one_open_idx
  ON core.break_glass_elevations (tenant_id, subject_id)
  WHERE state IN ('pending', 'active');

/**
 * History is kept as written.
 *
 * Purpose, target, expiry and the people involved are what a later review reads. Once set they
 * do not change; an elevation that turned out too long is released, not shortened in place.
 * Each lifecycle field is written once.
 */
CREATE OR REPLACE FUNCTION core.protect_break_glass_elevation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'break_glass_elevations: purpose, target and expiry cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (OLD.decided_at IS NOT NULL AND (
        NEW.decided_at IS DISTINCT FROM OLD.decided_at
        OR NEW.decided_by_subject_id IS DISTINCT FROM OLD.decided_by_subject_id
        OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason))
     OR (OLD.incident_recorded_at IS NOT NULL AND (
        NEW.incident_recorded_at IS DISTINCT FROM OLD.incident_recorded_at
        OR NEW.incident_reference IS DISTINCT FROM OLD.incident_reference
        OR NEW.incident_summary IS DISTINCT FROM OLD.incident_summary))
     OR (OLD.released_at IS NOT NULL AND (
        NEW.released_at IS DISTINCT FROM OLD.released_at
        OR NEW.release_cause IS DISTINCT FROM OLD.release_cause
        OR NEW.release_recovery_verification IS DISTINCT FROM OLD.release_recovery_verification)) THEN
    RAISE EXCEPTION 'break_glass_elevations: a recorded decision, incident or release cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.state IN ('rejected', 'released') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'break_glass_elevations: a closed elevation cannot be reopened'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER break_glass_elevations_guard
  BEFORE UPDATE ON core.break_glass_elevations
  FOR EACH ROW EXECUTE FUNCTION core.protect_break_glass_elevation();

CREATE TRIGGER break_glass_elevations_no_delete
  BEFORE DELETE ON core.break_glass_elevations
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

ALTER TABLE core.break_glass_elevations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.break_glass_elevations FORCE ROW LEVEL SECURITY;

CREATE POLICY break_glass_elevations_tenant ON core.break_glass_elevations FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.break_glass_elevations TO mpc_app;
