-- The anchor worker drains a cross-project queue without a human actor. Its existing SQL grants
-- define the allowed operations. Scope the RLS exceptions to the chain tables it actually uses.
CREATE POLICY anchor_worker_read ON chain.anchor_batches
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY anchor_worker_read ON chain.transactions
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY anchor_worker_update ON chain.transactions
  FOR UPDATE TO mpc_worker USING (true) WITH CHECK (true);

CREATE POLICY anchor_worker_read ON chain.anchor_sends
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY anchor_worker_insert ON chain.anchor_sends
  FOR INSERT TO mpc_worker WITH CHECK (true);
CREATE POLICY anchor_worker_update ON chain.anchor_sends
  FOR UPDATE TO mpc_worker USING (true) WITH CHECK (true);

CREATE POLICY anchor_worker_read ON chain.gas_spend
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY anchor_worker_insert ON chain.gas_spend
  FOR INSERT TO mpc_worker WITH CHECK (true);
CREATE POLICY anchor_worker_insert ON chain.reorg_events
  FOR INSERT TO mpc_worker WITH CHECK (true);

CREATE POLICY anchor_worker_read ON chain.anchor_proposals
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY anchor_worker_insert ON chain.anchor_proposals
  FOR INSERT TO mpc_worker WITH CHECK (true);
CREATE POLICY anchor_worker_update ON chain.anchor_proposals
  FOR UPDATE TO mpc_worker USING (true) WITH CHECK (true);
CREATE POLICY anchor_worker_read ON chain.safe_execution_history
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY anchor_worker_insert ON chain.safe_execution_history
  FOR INSERT TO mpc_worker WITH CHECK (true);

-- Confirmation, failure and reorg triggers enqueue these events in the same transaction.
CREATE POLICY anchor_worker_event_insert ON core.outbox
  FOR INSERT TO mpc_worker
  WITH CHECK (project_id IS NULL AND event_type IN ('anchor.confirmed', 'anchor.failed', 'anchor.reorged'));
