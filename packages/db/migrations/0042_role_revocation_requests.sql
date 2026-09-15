-- Two-person rule for role revocation — spec 02 §2.8, the mirror of 0028.
--
-- **Why:** 0028 made granting a role a two-person act, but there was no way to take one back.
-- Disabling every wallet of a person was the only de-facto revocation. That cut off everything
-- the person legitimately held, and it left the binding in force for the day a new key is bound.
--
-- Revocation changes the same thing a grant does — who holds which role — so it follows the
-- same rule: one person proposes, a different person decides, and the DB refuses the same person
-- doing both. A single operator could otherwise strip every other operator and be left alone
-- with the "role that grants roles".
--
-- **Revoking ends a binding; it never deletes one.** `role_bindings.revoked_at` has existed since
-- 0001, and `resolve_role_bindings` (0005, 0026) already skips rows where it is set. Sessions
-- are re-resolved per request, so a revoked binding stops authorizing on the next request. No
-- resolver change is needed here.

-- The FK below keeps a proposal and its binding in the same tenant (the 0006 pattern).
ALTER TABLE core.role_bindings
  ADD CONSTRAINT role_bindings_tenant_scope_key UNIQUE (tenant_id, id);

CREATE TYPE core.role_revocation_state AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

CREATE TABLE core.role_revocation_requests (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants(id),
  -- The binding to end. Who and which role come from it — a binding's identity never changes.
  role_binding_id         UUID NOT NULL,
  -- Offboarding, a changed duty, a security concern, and a mistaken grant have the same effect
  -- but call for different readings of what the person did while holding the role.
  reason_code             TEXT NOT NULL
                            CHECK (reason_code IN ('offboarding', 'duty_change', 'security_concern', 'granted_in_error')),
  reason                  TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by_subject_id UUID NOT NULL,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                   core.role_revocation_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id   UUID,
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,

  /**
   * Two-person rule — enforced by the DB, as for grants.
   *
   * Blocking only in the application means rechecking with every new route. Here, no path lets
   * the same person both propose and decide.
   */
  CONSTRAINT role_revocation_two_person CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> requested_by_subject_id
  ),
  CONSTRAINT role_revocation_decision_shape CHECK (
    (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL)
    OR (state = 'withdrawn' AND decided_at IS NOT NULL)
    OR (state IN ('approved', 'rejected') AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT role_revocation_binding_same_tenant
    FOREIGN KEY (tenant_id, role_binding_id) REFERENCES core.role_bindings (tenant_id, id),
  CONSTRAINT role_revocation_requester_same_tenant
    FOREIGN KEY (tenant_id, requested_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT role_revocation_decider_same_tenant
    FOREIGN KEY (tenant_id, decided_by_subject_id) REFERENCES core.subjects (tenant_id, id)
);

CREATE INDEX role_revocation_requests_pending_idx
  ON core.role_revocation_requests (tenant_id, state, requested_at DESC);

/**
 * Only one pending proposal per binding.
 *
 * With two open, history blurs which one the approver approved — the same reason as
 * `role_grant_requests_one_pending_idx`.
 */
CREATE UNIQUE INDEX role_revocation_requests_one_pending_idx
  ON core.role_revocation_requests (role_binding_id)
  WHERE state = 'pending';

ALTER TABLE core.role_revocation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.role_revocation_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY role_revocation_requests_tenant ON core.role_revocation_requests FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.role_revocation_requests TO mpc_app;

/**
 * A decision is final, and what was proposed never changes.
 *
 * Reopening a rejected proposal would let it be approved later by someone who never saw the
 * first decision; rewriting the target would make an approval apply to a binding the approver
 * did not look at.
 */
CREATE OR REPLACE FUNCTION core.protect_role_revocation_request() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'role_revocation_requests: a decided proposal cannot be changed'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.role_binding_id IS DISTINCT FROM OLD.role_binding_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by_subject_id IS DISTINCT FROM OLD.requested_by_subject_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'role_revocation_requests: what was proposed cannot be changed'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER role_revocation_requests_guard
  BEFORE UPDATE ON core.role_revocation_requests
  FOR EACH ROW EXECUTE FUNCTION core.protect_role_revocation_request();

CREATE TRIGGER role_revocation_requests_no_delete
  BEFORE DELETE ON core.role_revocation_requests
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

/**
 * Revocation is final.
 *
 * Clearing `revoked_at` would hand the role back with one UPDATE, skipping the grant proposal
 * that giving a role requires. Re-granting goes through a new proposal and creates a new
 * binding, so the history shows both the revocation and the second grant.
 *
 * The identity of a binding (who, which role, where) is not rewritten either: an approved
 * revocation names a binding, and that name must keep meaning the same thing.
 */
CREATE OR REPLACE FUNCTION core.protect_role_binding() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_bindings: a revoked binding cannot be changed. Grant again through a new proposal'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'role_bindings: who holds which role cannot be rewritten. Revoke and grant instead'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER role_bindings_guard
  BEFORE UPDATE ON core.role_bindings
  FOR EACH ROW EXECUTE FUNCTION core.protect_role_binding();
