-- Separated approval for the review registries — spec 02 §2.8, W-066 / Q-020.
--
-- **Why:** credentials, attestation schemas and compliance policy sets were created only by the
-- operator CLI in `apps/api/src/bootstrap-registry.ts`. "Approval" there is a name the operator
-- types, recorded as a statement — nobody the app identifies approved anything. 02 §2.8 asks for
-- schema/policy approval by "the Protocol's designated review role", recorded with version,
-- rationale and effective date, and for credential confirmation by a separate verifier.
--
-- **One table for all three registries, with a `kind` discriminator.** The lifecycle is the same
-- (propose → decide → materialize) and so are the rules that matter most here: two people, a
-- stated rationale, no edits after the fact, no deletes. Written once, a fourth registry cannot
-- forget one of them. The typed payload is validated by the API with the same validators the
-- bootstrap CLI uses, and the approved row lands in the existing typed table, whose own
-- constraints still apply.
--
-- **Two-person rule, enforced here** — the same as `role_grant_two_person` (0028). An
-- HTTP-reachable path widens what one hijacked operator session can reach; requiring a second,
-- different person to approve keeps that session from creating trusted registry rows alone.
--
-- The bootstrap CLI does not write here. It has no identified person to record as proposer; it
-- stays the seed path for a fresh environment and writes the same rows through the same function.

CREATE TYPE core.registry_kind AS ENUM ('credential', 'attestation_schema', 'policy_set');
CREATE TYPE core.registry_proposal_state AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE core.registry_proposals (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  kind                   core.registry_kind NOT NULL,
  -- The logical registry item: rule set id, schema key, or holder + issuer reference.
  item_key               TEXT NOT NULL CHECK (length(btrim(item_key)) > 0),
  -- Monotonic per item. A rejected version keeps its number — the history shows it was proposed.
  item_version           INTEGER NOT NULL CHECK (item_version > 0),
  -- What approval will write, already validated and normalized.
  payload                JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- A proposal without a reason leaves nothing to review against.
  rationale              TEXT NOT NULL CHECK (length(btrim(rationale)) > 0),
  effective_from         TIMESTAMPTZ NOT NULL,
  proposed_by_subject_id UUID NOT NULL,
  proposed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  state                  core.registry_proposal_state NOT NULL DEFAULT 'pending',
  decided_by_subject_id  UUID,
  decided_at             TIMESTAMPTZ,
  decision_reason        TEXT,
  -- The registry row approval created. Same role as `role_grant_requests.role_binding_id`.
  materialized_id        UUID,
  -- Row version for If-Match. Not the item version.
  version                INTEGER NOT NULL DEFAULT 1,

  /**
   * Two-person rule — enforced by the DB.
   *
   * Blocking only in the application means rechecking with every new route. Here, no path lets
   * the same person both propose and decide.
   */
  CONSTRAINT registry_proposal_two_person CHECK (
    decided_by_subject_id IS NULL OR decided_by_subject_id <> proposed_by_subject_id
  ),
  -- `IS NOT NULL` is spelled out: a CHECK whose expression is NULL passes.
  CONSTRAINT registry_proposal_decision_shape CHECK (
    (state = 'pending'
      AND decided_by_subject_id IS NULL AND decided_at IS NULL
      AND decision_reason IS NULL AND materialized_id IS NULL)
    OR (state = 'rejected'
      AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0
      AND materialized_id IS NULL)
    OR (state = 'approved'
      AND decided_by_subject_id IS NOT NULL AND decided_at IS NOT NULL
      AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) > 0
      AND materialized_id IS NOT NULL)
  ),
  CONSTRAINT registry_proposals_item_version_key UNIQUE (tenant_id, kind, item_key, item_version),
  -- One proposal per registry row. Approving twice cannot point two proposals at one row.
  CONSTRAINT registry_proposals_materialized_key UNIQUE (kind, materialized_id),
  CONSTRAINT registry_proposals_tenant_scope_key UNIQUE (tenant_id, id),
  CONSTRAINT registry_proposals_proposer_same_tenant
    FOREIGN KEY (tenant_id, proposed_by_subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT registry_proposals_decider_same_tenant
    FOREIGN KEY (tenant_id, decided_by_subject_id) REFERENCES core.subjects (tenant_id, id)
);

/**
 * Only one pending proposal per item.
 *
 * With two open, the order they are approved in decides which version the history calls later,
 * and an approver reading one cannot see what the other changes.
 */
CREATE UNIQUE INDEX registry_proposals_one_pending_idx
  ON core.registry_proposals (tenant_id, kind, item_key)
  WHERE state = 'pending';

CREATE INDEX registry_proposals_list_idx
  ON core.registry_proposals (tenant_id, kind, proposed_at DESC);

/**
 * What was proposed never changes, and a decision is final.
 *
 * A proposal is inserted as `pending` — a row born approved would skip the decision step. After
 * that only the decision columns move, once. Superseding means proposing a new version; the old
 * proposal and the row it created stay as they were.
 */
CREATE OR REPLACE FUNCTION core.guard_registry_proposal() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'A registry proposal must be proposed as pending. Deciding is a separate step'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'A decided registry proposal cannot be modified. Propose a new version'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (NEW.tenant_id, NEW.kind, NEW.item_key, NEW.item_version, NEW.payload, NEW.rationale,
      NEW.effective_from, NEW.proposed_by_subject_id, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.kind, OLD.item_key, OLD.item_version, OLD.payload, OLD.rationale,
      OLD.effective_from, OLD.proposed_by_subject_id, OLD.proposed_at) THEN
    RAISE EXCEPTION 'A registry proposal cannot be modified after it is proposed. Propose a new version'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER registry_proposals_guard
  BEFORE INSERT OR UPDATE ON core.registry_proposals
  FOR EACH ROW EXECUTE FUNCTION core.guard_registry_proposal();

CREATE TRIGGER registry_proposals_no_delete
  BEFORE DELETE ON core.registry_proposals
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

ALTER TABLE core.registry_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.registry_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY registry_proposals_tenant ON core.registry_proposals FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.registry_proposals TO mpc_app;
