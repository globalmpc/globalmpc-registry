-- Governance — spec 04 §4.5, OD-06
--
-- Protocol governance and Project governance share **one table, separated by space**.
-- Separate tables would mean maintaining two copies of the same state machine and quorum
-- calculation, and if they diverge nobody can tell which is right.
--
-- `space` and `project_id` enforce the separation.
--
--   - A protocol proposal must have NULL `project_id`.
--   - A project proposal must have a `project_id`.
--
-- **Votes do not create off-chain facts** (invariant 12). This schema has no column that
-- changes authority·credential·legal status from a vote result. The result is only
-- recorded in `execution_*`; actual enforcement is a separate act.

CREATE TYPE core.governance_space AS ENUM ('protocol', 'project');

CREATE TYPE core.proposal_state AS ENUM (
  'draft', 'review', 'announced', 'voting',
  'succeeded', 'defeated', 'no_quorum',
  'timelocked', 'recorded', 'execution_pending',
  'executed', 'failed', 'disputed', 'cancelled'
);

CREATE TABLE core.governance_proposals (
  id                UUID PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES core.tenants(id),
  space             core.governance_space NOT NULL,
  -- Filled only in project space. Enforced by the CHECK below.
  project_id        UUID,
  proposal_type     TEXT NOT NULL,
  title             TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  -- What it proposes to change. A proposal without a reason gives no basis for judgment.
  rationale         TEXT NOT NULL CHECK (length(btrim(rationale)) > 0),
  state             core.proposal_state NOT NULL DEFAULT 'draft',
  proposer_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  -- Quorum and passing threshold are fixed at proposal time. They cannot be changed later
  -- to flip the result (§4.5 non-retroactive).
  quorum_numerator  INTEGER NOT NULL CHECK (quorum_numerator > 0),
  quorum_denominator INTEGER NOT NULL CHECK (quorum_denominator > 0),
  threshold_numerator INTEGER NOT NULL CHECK (threshold_numerator > 0),
  threshold_denominator INTEGER NOT NULL CHECK (threshold_denominator > 0),
  voting_opens_at   TIMESTAMPTZ,
  voting_closes_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version           INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT proposal_space_scope CHECK (
    (space = 'protocol' AND project_id IS NULL)
    OR (space = 'project' AND project_id IS NOT NULL)
  ),
  CONSTRAINT proposal_voting_window CHECK (
    voting_closes_at IS NULL OR voting_opens_at IS NULL
    OR voting_closes_at > voting_opens_at
  ),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

-- Including tenant in the FK requires a composite UNIQUE on the parent. Create it before
-- the child tables (same reason as 0006 — FK checks bypass RLS).
ALTER TABLE core.governance_proposals ADD CONSTRAINT governance_proposals_tenant_scope_key
  UNIQUE (tenant_id, id);

CREATE INDEX governance_proposals_space_idx
  ON core.governance_proposals (tenant_id, space, state);

/**
 * Vote.
 *
 * A subject votes only once per proposal. To change it, update the existing vote rather
 * than cast a new one — two remaining votes would require deciding which is valid.
 *
 * **Vote weight is stored here.** Later balance changes do not alter the weight of a vote
 * already cast. Otherwise the result would differ at every tally.
 */
CREATE TABLE core.governance_votes (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  proposal_id   UUID NOT NULL,
  voter_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  choice        TEXT NOT NULL CHECK (choice IN ('for', 'against', 'abstain')),
  -- Decimal string. Same reason as avoiding JSON numbers (ADR-T07).
  weight        NUMERIC(78, 0) NOT NULL CHECK (weight >= 0),
  cast_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, voter_subject_id),
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES core.governance_proposals (tenant_id, id)
);

CREATE INDEX governance_votes_proposal_idx ON core.governance_votes (proposal_id);

/**
 * State transition history.
 *
 * Records the path a proposal took. By current state alone, "ended below quorum" and
 * "cancelled" look the same.
 */
CREATE TABLE core.governance_transitions (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  proposal_id   UUID NOT NULL,
  from_state    core.proposal_state NOT NULL,
  to_state      core.proposal_state NOT NULL,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_subject_id UUID,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Freeze the tally result too. Even if votes change later, the basis of that decision remains.
  tally_snapshot JSONB,
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES core.governance_proposals (tenant_id, id)
);

CREATE INDEX governance_transitions_proposal_idx
  ON core.governance_transitions (proposal_id, occurred_at);

ALTER TABLE core.governance_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE core.governance_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_votes FORCE ROW LEVEL SECURITY;
ALTER TABLE core.governance_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_transitions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.governance_proposals
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY tenant_isolation ON core.governance_votes
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY tenant_isolation ON core.governance_transitions
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.governance_proposals TO mpc_app;
-- Votes can be updated (voters may change their minds). No deletion — never having voted
-- and having withdrawn a vote are different facts.
GRANT SELECT, INSERT, UPDATE ON core.governance_votes TO mpc_app;
-- Transition history is append-only.
GRANT SELECT, INSERT ON core.governance_transitions TO mpc_app;

/**
 * Votes cannot change after voting ends.
 *
 * The application checks this, but that is not enough — one vote changing after the tally
 * would contradict the already recorded result.
 */
CREATE OR REPLACE FUNCTION core.reject_vote_after_close() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  proposal_state core.proposal_state;
BEGIN
  SELECT state INTO proposal_state
  FROM core.governance_proposals WHERE id = NEW.proposal_id;

  IF proposal_state <> 'voting' THEN
    RAISE EXCEPTION 'Voting is not open (proposal state: %)', proposal_state;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER governance_votes_only_while_voting
  BEFORE INSERT OR UPDATE ON core.governance_votes
  FOR EACH ROW EXECUTE FUNCTION core.reject_vote_after_close();

CREATE OR REPLACE FUNCTION core.reject_delete_governance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be deleted', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER governance_votes_no_delete
  BEFORE DELETE ON core.governance_votes
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();

CREATE TRIGGER governance_transitions_no_delete
  BEFORE DELETE ON core.governance_transitions
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();

CREATE TRIGGER governance_proposals_no_delete
  BEFORE DELETE ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();
