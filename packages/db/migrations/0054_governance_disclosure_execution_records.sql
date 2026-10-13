-- Proposal disclosure and off-chain execution records — spec 09 §9.4, §9.7, 04 §4.2, 02 §2.3
--
-- Two gaps closed here.
--
-- 1. **A proposal did not carry its conflict-of-interest disclosure or execution mode.** 04 §4.2
--    lists both among the fields a proposal fixes at creation. Without the disclosure, voters
--    decide without knowing who stands to gain; without the execution mode, a passed proposal
--    does not say whether anything happens on chain or only in contracts outside it.
--
-- 2. **`execution_pending → executed` needed only a free-text reason.** 09 §9.7 requires an
--    Execution Record: who executed, under what authority, what was executed, and the evidence.
--    A reason line lets "executed" be declared with nothing behind it.
--
-- The conflict *gate* (which conflicts block a vote, heightened thresholds) is not here — its
-- rules and values are undecided (OD-10, OD-11, OD-12). Only the disclosure is stored.

ALTER TABLE core.governance_proposals
  -- Nullable only for proposals created before this migration. New rows are held to it by
  -- the trigger below; a CHECK would also reject state transitions of those older rows.
  ADD COLUMN conflict_disclosure TEXT,
  ADD COLUMN execution_mode TEXT
    CHECK (execution_mode IN ('record_only', 'onchain_bounded', 'offchain_required'));

/**
 * New proposals must state both fields, and neither changes afterwards.
 *
 * "No known conflict" is itself a disclosure the proposer answers for, so an explicit
 * statement is required rather than an empty value. Editing it after votes are cast would
 * change what the voters were told.
 */
CREATE OR REPLACE FUNCTION core.check_proposal_disclosure() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.conflict_disclosure IS NULL OR length(btrim(NEW.conflict_disclosure)) = 0 THEN
      RAISE EXCEPTION 'A proposal must carry a conflict-of-interest disclosure';
    END IF;
    IF NEW.execution_mode IS NULL THEN
      RAISE EXCEPTION 'A proposal must state its execution mode';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.conflict_disclosure IS DISTINCT FROM OLD.conflict_disclosure
     OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN
    RAISE EXCEPTION 'The disclosure and execution mode of a proposal cannot be changed';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_proposals_disclosure
  BEFORE INSERT OR UPDATE ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.check_proposal_disclosure();

/**
 * Execution Record — 09 §9.7.
 *
 * **Separate from the vote.** No column here refers to votes or the tally, and the recorder
 * cannot change them (02 §2.4 rule 9). The vote result says what was decided; this record says
 * what was done about it outside the chain, by whom, and on what evidence.
 *
 * `outcome` is the state the proposal moves to. A failed or disputed execution needs a record
 * too — "it failed" without evidence is as unverifiable as "it was done".
 *
 * Evidence is referenced by location and hash, not stored. Signed contracts and transfer
 * documents are confidential; the hash lets a later reader confirm which document was meant.
 */
CREATE TABLE core.governance_execution_records (
  id                  UUID PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES core.tenants(id),
  proposal_id         UUID NOT NULL,
  from_state          core.proposal_state NOT NULL
                        CHECK (from_state IN ('execution_pending', 'disputed')),
  outcome             core.proposal_state NOT NULL
                        CHECK (outcome IN ('executed', 'failed', 'disputed')),
  recorder_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  -- Who carried out the act off chain (a party, not necessarily the recorder).
  executor            TEXT NOT NULL CHECK (length(btrim(executor)) > 0),
  -- The authority or contract under which the executor acted.
  authority           TEXT NOT NULL CHECK (length(btrim(authority)) > 0),
  -- What was executed.
  executed_action     TEXT NOT NULL CHECK (length(btrim(executed_action)) > 0),
  contract_reference  TEXT,
  contract_hash       TEXT CHECK (contract_hash ~ '^0x[0-9a-f]{64}$'),
  external_reference  TEXT,
  effective_date      DATE,
  evidence_reference  TEXT NOT NULL CHECK (length(btrim(evidence_reference)) > 0),
  evidence_hash       TEXT NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  -- What this record does not establish. Same rule as attestations (AC-01).
  limitations         TEXT[] NOT NULL CHECK (cardinality(limitations) > 0),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT execution_record_moves_state CHECK (outcome <> from_state),
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES core.governance_proposals (tenant_id, id)
);

CREATE INDEX governance_execution_records_proposal_idx
  ON core.governance_execution_records (proposal_id, recorded_at);

ALTER TABLE core.governance_execution_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_execution_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.governance_execution_records
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- Append-only. A correction is a new record (a dispute), never an edit.
GRANT SELECT, INSERT ON core.governance_execution_records TO mpc_app;

CREATE TRIGGER governance_execution_records_no_delete
  BEFORE DELETE ON core.governance_execution_records
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete_governance();

/**
 * A record is accepted only while the proposal is where the record says it starts.
 *
 * Without this, a record could be written for a proposal still in voting, and the later
 * transition would find it waiting.
 */
CREATE OR REPLACE FUNCTION core.check_execution_record_state() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  current_state core.proposal_state;
BEGIN
  SELECT state INTO current_state
  FROM core.governance_proposals WHERE id = NEW.proposal_id;

  IF current_state IS DISTINCT FROM NEW.from_state THEN
    RAISE EXCEPTION 'Execution record starts from % but the proposal is %',
      NEW.from_state, current_state;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_execution_records_state
  BEFORE INSERT ON core.governance_execution_records
  FOR EACH ROW EXECUTE FUNCTION core.check_execution_record_state();

/**
 * Leaving `execution_pending` or `disputed` requires a matching Execution Record.
 *
 * The API writes the record and the transition together; this makes the rule hold for any
 * other writer too — a transition with only a reason is what this migration removes.
 */
CREATE OR REPLACE FUNCTION core.require_execution_record() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NEW.state IN ('executed', 'failed', 'disputed') THEN
    IF NOT EXISTS (
      SELECT 1 FROM core.governance_execution_records r
      WHERE r.proposal_id = NEW.id
        AND r.from_state = OLD.state
        AND r.outcome = NEW.state
    ) THEN
      RAISE EXCEPTION 'Moving a proposal to % requires an execution record', NEW.state;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER governance_proposals_execution_record
  BEFORE UPDATE OF state ON core.governance_proposals
  FOR EACH ROW EXECUTE FUNCTION core.require_execution_record();
