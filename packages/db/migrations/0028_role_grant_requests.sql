-- Two-person rule for role grants — spec 02 §2.8.
--
-- **Why:** the only path to grant a role was the CLI in
-- `apps/api/src/bootstrap.ts`. Adding a person to a deployed system meant logging into the server each time, and that
-- path runs on a superuser connection that bypasses RLS.
--
-- Moving this to UI/API creates a new **role that grants roles**. If that one role
-- could give itself anything, the rest of the permission model would lose its meaning.
--
-- 02 §2.8 forbids "operator-only transition to accepted", and this repo already enforces in code
-- that "the registrant cannot approve that authority". **The same rule applies to role
-- grants** — a different person proposes and approves.
--
-- The first person cannot be created through this table (no one to approve). The `bootstrap` CLI
-- keeps that role — a seed run once per deployment, not a standing path.

CREATE TYPE core.role_grant_state AS ENUM ('pending', 'approved', 'rejected', 'withdrawn');

CREATE TABLE core.role_grant_requests (
  id                      UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL REFERENCES core.tenants(id),
  -- Who receives the grant.
  subject_id              UUID NOT NULL REFERENCES core.subjects(id),
  organization_id         UUID REFERENCES core.organizations(id),
  -- Set for a project-scoped binding. NULL at organization level.
  project_id              UUID,
  role                    TEXT NOT NULL CHECK (length(btrim(role)) > 0),
  -- A grant without a reason leaves no basis for later judgment. Required on both proposal and decision.
  reason                  TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                   core.role_grant_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id   UUID REFERENCES core.subjects(id),
  decided_at              TIMESTAMPTZ,
  decision_reason         TEXT,
  -- The binding the grant actually created. Set only after approval.
  role_binding_id         UUID REFERENCES core.role_bindings(id),
  version                 INTEGER NOT NULL DEFAULT 1,

  /**
   * Two-person rule — enforced by the DB.
   *
   * Blocking only in the application means rechecking with every new route. Here,
   * no path lets the same person both propose and approve.
   */
  CONSTRAINT role_grant_two_person CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> requested_by_subject_id
  ),
  CONSTRAINT role_grant_decision_shape CHECK (
    (state = 'pending' AND decided_by_subject_id IS NULL AND decided_at IS NULL)
    OR (state = 'withdrawn' AND decided_at IS NOT NULL)
    OR (state IN ('approved', 'rejected') AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT role_grant_binding_shape CHECK (
    role_binding_id IS NULL OR state = 'approved'
  ),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

CREATE INDEX role_grant_requests_pending_idx
  ON core.role_grant_requests (tenant_id, state, requested_at DESC);

/**
 * Only one pending proposal per target.
 *
 * With two open, history blurs which one the approver approved, and approving
 * both would create the same binding twice.
 */
CREATE UNIQUE INDEX role_grant_requests_one_pending_idx
  ON core.role_grant_requests (tenant_id, subject_id, role, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state = 'pending';

ALTER TABLE core.role_grant_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.role_grant_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY role_grant_requests_tenant ON core.role_grant_requests FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.role_grant_requests TO mpc_app;

/**
 * Wallet disable history — AC-27.
 *
 * `wallet_identities.disabled_at` existed as a column with no path to set it.
 * So **there was no way at all to cut off a lost key.**
 *
 * Cutting off is not enough. Without a reason, there is no way to judge later how to
 * read that account's past signatures — loss, departure, and compromise differ.
 */
CREATE TABLE core.wallet_disable_events (
  id                    UUID PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES core.tenants(id),
  wallet_identity_id    UUID NOT NULL REFERENCES core.wallet_identities(id),
  reason_code           TEXT NOT NULL
                          CHECK (reason_code IN ('key_lost', 'key_compromised', 'rotation', 'offboarding')),
  detail                TEXT NOT NULL CHECK (length(btrim(detail)) > 0),
  disabled_by_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  disabled_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX wallet_disable_events_wallet_idx
  ON core.wallet_disable_events (wallet_identity_id, disabled_at DESC);

ALTER TABLE core.wallet_disable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.wallet_disable_events FORCE ROW LEVEL SECURITY;

CREATE POLICY wallet_disable_events_tenant ON core.wallet_disable_events FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.wallet_disable_events TO mpc_app;
