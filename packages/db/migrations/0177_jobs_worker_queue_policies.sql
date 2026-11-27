-- The jobs worker consumes queues and sweeps evidence across projects, without a request actor.
-- Its deployment login inherits table grants from mpc_worker, but not BYPASSRLS.
CREATE POLICY jobs_worker_read ON core.outbox
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_update ON core.outbox
  FOR UPDATE TO mpc_worker USING (true) WITH CHECK (true);

CREATE POLICY jobs_worker_read ON core.notification_deliveries
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_update ON core.notification_deliveries
  FOR UPDATE TO mpc_worker USING (true) WITH CHECK (true);
CREATE POLICY jobs_worker_read ON core.notification_sinks
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.notifications
  FOR SELECT TO mpc_worker USING (true);

CREATE POLICY jobs_worker_read ON core.project_export_jobs
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_update ON core.project_export_jobs
  FOR UPDATE TO mpc_worker USING (true) WITH CHECK (true);

-- Project reads shared by export assembly and evidence assessments.
CREATE POLICY jobs_worker_read ON core.projects
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.verification_attestations
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.verification_cases
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.source_receipts
  FOR SELECT TO mpc_worker USING (true);

-- Export inputs. Package generation still applies the job's recorded sensitivity clearance.
CREATE POLICY jobs_worker_read ON core.registry_entries
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.registry_entry_versions
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.gate_decisions
  FOR SELECT TO mpc_worker USING (true);

-- Evidence assessments and the invoker functions that resolve their current inputs.
CREATE POLICY jobs_worker_read ON core.claim_types
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.claims
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.credentials
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.attestation_schemas
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.project_fact_versions
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.compliance_policy_sets
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.jurisdiction_profiles
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_read ON core.evidence_ledger_snapshots
  FOR SELECT TO mpc_worker USING (true);
CREATE POLICY jobs_worker_insert ON core.evidence_ledger_snapshots
  FOR INSERT TO mpc_worker WITH CHECK (true);

-- Return only the ledger's project-keyed claim health results to the global worker.
-- Its shared role must not gain direct access to uploads outside the scan service actor.
CREATE FUNCTION core.worker_ledger_claim_health(p_project UUID, p_asof TIMESTAMPTZ)
RETURNS TABLE (
  id UUID, claim_type TEXT, catalog_entry_id UUID, catalog_version INTEGER,
  grade core.grade, as_of DATE, value_text TEXT, stale BOOLEAN, has_evidence BOOLEAN,
  conflict_ids UUID[], conflict_types TEXT[], upload_ids UUID[], signal_ids UUID[],
  excluded_by_rule BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $$
  SELECT * FROM core.ledger_claim_health(p_project, p_asof);
$$;
REVOKE ALL ON FUNCTION core.worker_ledger_claim_health(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.worker_ledger_claim_health(UUID, TIMESTAMPTZ) TO mpc_worker;
