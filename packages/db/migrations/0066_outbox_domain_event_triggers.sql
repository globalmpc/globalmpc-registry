-- Domain events emitted from state changes — spec 07 §7.4.
--
-- **Why triggers and not route code.** The state changes below happen in several places: the
-- anchor worker moves chain transactions, governance routes insert transitions, and credential
-- or evidence status can change from registry approvals and propagation. An event written next
-- to each UPDATE is missed the first time a new path forgets it. A trigger on the state column
-- fires for every path, and it fires inside the same transaction — the §7.5 rule that the
-- domain change and the outbox row commit or roll back together holds by construction.
--
-- **Security invoker.** The row is inserted with the privileges of whoever changed the state.
-- An API request inserts under its tenant's RLS policy, which the changed row has already
-- passed; the worker inserts with the grant from 0065. No definer function widens anyone's reach.
--
-- **Correlation.** A trigger cannot see the HTTP request id. It uses the transaction id, so
-- every event from one transaction — including a route's own event — can be joined on it
-- together with `occurred_at`.
--
-- Payloads carry identifiers and states only, never names, text or evidence content.
--
-- Not covered: `incident.*` has no table yet, so there is no state change to observe.

CREATE FUNCTION core.outbox_emit(
  p_tenant_id UUID,
  p_event_type TEXT,
  p_aggregate_id UUID,
  p_aggregate_version INTEGER,
  p_project_id UUID,
  p_payload JSONB
) RETURNS VOID
LANGUAGE sql
SET search_path = core, pg_temp
AS $$
  INSERT INTO core.outbox (
    id, tenant_id, event_type, schema_version, aggregate_id, aggregate_version,
    project_id, payload, correlation_id
  ) VALUES (
    gen_random_uuid(), p_tenant_id, p_event_type, 1, p_aggregate_id, p_aggregate_version,
    p_project_id, p_payload, 'txid:' || txid_current()::text
  )
$$;

-- ---------------------------------------------------------------------------
-- Anchor — 07 §7.7. `anchor.submitted` is emitted by the route that creates the batch.
-- ---------------------------------------------------------------------------

/**
 * `confirmed` is the only success (06 §6.8), so `included` emits nothing. The terminal failure
 * states share one event type; the payload names which one. `reconciliation_required` is not a
 * failure — a person decides — so it emits nothing here.
 */
CREATE FUNCTION core.outbox_on_anchor_transaction_state() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = core, chain, pg_temp
AS $$
DECLARE
  v_event TEXT;
BEGIN
  IF NEW.state = 'confirmed' THEN
    v_event := 'anchor.confirmed';
  ELSIF NEW.state IN ('failed', 'reverted', 'dropped') THEN
    v_event := 'anchor.failed';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM core.outbox_emit(
    NEW.tenant_id, v_event, COALESCE(NEW.batch_id, NEW.id), NEW.version, NULL,
    jsonb_build_object(
      'transactionId', NEW.id,
      'batchRowId', NEW.batch_id,
      'chainId', NEW.chain_id,
      'txHash', NEW.tx_hash,
      'blockNumber', NEW.block_number,
      'fromState', OLD.state,
      'toState', NEW.state
    )
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_anchor_transaction_state
  AFTER UPDATE OF state ON chain.transactions
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION core.outbox_on_anchor_transaction_state();

/**
 * A reorg is recorded as its own row (0012), not as a state — the transaction goes back to
 * `submitted`/`included` or to `reconciliation_required`. The row is the fact to announce.
 */
CREATE FUNCTION core.outbox_on_anchor_reorg() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = core, chain, pg_temp
AS $$
DECLARE
  v_batch UUID;
  v_version INTEGER;
BEGIN
  SELECT t.batch_id, t.version INTO v_batch, v_version
  FROM chain.transactions t WHERE t.id = NEW.transaction_id;

  PERFORM core.outbox_emit(
    NEW.tenant_id, 'anchor.reorged', COALESCE(v_batch, NEW.transaction_id),
    COALESCE(v_version, 1), NULL,
    jsonb_build_object(
      'transactionId', NEW.transaction_id,
      'batchRowId', v_batch,
      'previousBlockNumber', NEW.previous_block_number,
      'previousBlockHash', NEW.previous_block_hash,
      'detectedState', NEW.detected_state
    )
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_anchor_reorg
  AFTER INSERT ON chain.reorg_events
  FOR EACH ROW
  EXECUTE FUNCTION core.outbox_on_anchor_reorg();

-- ---------------------------------------------------------------------------
-- Credential — `credential.verified|expired|revoked`
-- ---------------------------------------------------------------------------

/**
 * A credential is only ever created `valid` (registry approval checks it first), so creation is
 * the verification. `suspended` and `unknown` have no event type in §7.4 and emit nothing —
 * inventing one here would be a contract nobody agreed to.
 */
CREATE FUNCTION core.outbox_on_credential_status() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
DECLARE
  v_event TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_status <> 'valid' THEN
      RETURN NULL;
    END IF;
    v_event := 'credential.verified';
  ELSIF NEW.current_status = 'expired' THEN
    v_event := 'credential.expired';
  ELSIF NEW.current_status = 'revoked' THEN
    v_event := 'credential.revoked';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM core.outbox_emit(
    NEW.tenant_id, v_event, NEW.id, NEW.version, NULL,
    jsonb_build_object(
      'credentialId', NEW.id,
      'subjectId', NEW.subject_id,
      'credentialType', NEW.credential_type,
      'fromStatus', CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_status END,
      'toStatus', NEW.current_status
    )
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_credential_created
  AFTER INSERT ON core.credentials
  FOR EACH ROW
  EXECUTE FUNCTION core.outbox_on_credential_status();

CREATE TRIGGER outbox_credential_status
  AFTER UPDATE OF current_status ON core.credentials
  FOR EACH ROW
  WHEN (OLD.current_status IS DISTINCT FROM NEW.current_status)
  EXECUTE FUNCTION core.outbox_on_credential_status();

-- ---------------------------------------------------------------------------
-- Evidence version — `evidence.version.revoked|superseded`
-- ---------------------------------------------------------------------------

/**
 * Artifacts are immutable versions without a version counter. The aggregate version counts the
 * lifecycle marks set on the row, so a revoke after a supersede reads as a later version.
 */
CREATE FUNCTION core.outbox_on_evidence_version() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
DECLARE
  v_version INTEGER := 1
    + (CASE WHEN NEW.superseded_by IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN NEW.revoked_at IS NOT NULL THEN 1 ELSE 0 END);
BEGIN
  IF OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL THEN
    PERFORM core.outbox_emit(
      NEW.tenant_id, 'evidence.version.superseded', NEW.id, v_version, NEW.project_id,
      jsonb_build_object(
        'artifactId', NEW.id,
        'kind', NEW.kind,
        'supersededBy', NEW.superseded_by
      )
    );
  END IF;

  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    PERFORM core.outbox_emit(
      NEW.tenant_id, 'evidence.version.revoked', NEW.id, v_version, NEW.project_id,
      jsonb_build_object(
        'artifactId', NEW.id,
        'kind', NEW.kind,
        'revokedAt', NEW.revoked_at
      )
    );
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_evidence_version
  AFTER UPDATE OF superseded_by, revoked_at ON core.artifacts
  FOR EACH ROW
  EXECUTE FUNCTION core.outbox_on_evidence_version();

-- ---------------------------------------------------------------------------
-- Governance — `governance.proposal.created|finalized`, `execution.status.changed`
-- ---------------------------------------------------------------------------

CREATE FUNCTION core.outbox_on_governance_proposal_created() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
BEGIN
  PERFORM core.outbox_emit(
    NEW.tenant_id, 'governance.proposal.created', NEW.id, NEW.version, NEW.project_id,
    jsonb_build_object(
      'proposalId', NEW.id,
      'space', NEW.space,
      'proposalType', NEW.proposal_type,
      'state', NEW.state
    )
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_governance_proposal_created
  AFTER INSERT ON core.governance_proposals
  FOR EACH ROW
  EXECUTE FUNCTION core.outbox_on_governance_proposal_created();

/**
 * Transitions are the record of every state change (0017), so the events hang off them.
 *
 * - **finalized** — the vote result is fixed: `succeeded`, `defeated` or `no_quorum`
 *   (09 §9.6: no tally mutation after finalization).
 * - **execution.status.changed** — entering `execution_pending`, or leaving it. Off-chain
 *   execution is a separate act from the vote (09 §9.7), and this is its status stream.
 */
CREATE FUNCTION core.outbox_on_governance_transition() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
DECLARE
  v_project UUID;
  v_version INTEGER;
BEGIN
  SELECT p.project_id, p.version INTO v_project, v_version
  FROM core.governance_proposals p
  WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.proposal_id;

  IF NEW.to_state IN ('succeeded', 'defeated', 'no_quorum') THEN
    PERFORM core.outbox_emit(
      NEW.tenant_id, 'governance.proposal.finalized', NEW.proposal_id,
      COALESCE(v_version, 1), v_project,
      jsonb_build_object(
        'proposalId', NEW.proposal_id,
        'transitionId', NEW.id,
        'result', NEW.to_state
      )
    );
  END IF;

  IF NEW.to_state = 'execution_pending' OR NEW.from_state = 'execution_pending' THEN
    PERFORM core.outbox_emit(
      NEW.tenant_id, 'execution.status.changed', NEW.proposal_id,
      COALESCE(v_version, 1), v_project,
      jsonb_build_object(
        'proposalId', NEW.proposal_id,
        'transitionId', NEW.id,
        'fromState', NEW.from_state,
        'toState', NEW.to_state
      )
    );
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER outbox_governance_transition
  AFTER INSERT ON core.governance_transitions
  FOR EACH ROW
  EXECUTE FUNCTION core.outbox_on_governance_transition();
