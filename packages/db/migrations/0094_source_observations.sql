-- Observations retain the outcome of each server collection independently of immutable receipts.
-- Byte-level changes are review signals, never a replacement expert judgment or withdrawal.
CREATE TABLE core.source_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  tenant_id UUID NOT NULL REFERENCES core.tenants(id),
  project_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  receipt_id UUID NOT NULL UNIQUE,
  previous_receipt_id UUID,
  query_basis JSONB NOT NULL CHECK (jsonb_typeof(query_basis) = 'object'),
  observed_at TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('baseline','unchanged','changed','unavailable','no_record','out_of_order')),
  affected_claim_ids UUID[] NOT NULL DEFAULT '{}',
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id,id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES core.source_connections (tenant_id,id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES core.source_receipts (tenant_id,id),
  FOREIGN KEY (tenant_id, previous_receipt_id) REFERENCES core.source_receipts (tenant_id,id)
);
CREATE INDEX source_observations_scope_idx ON core.source_observations
  (tenant_id, project_id, connection_id, observed_at DESC);
ALTER TABLE core.source_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.source_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.source_observations
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());
GRANT SELECT, INSERT ON core.source_observations TO mpc_app;
GRANT USAGE ON SEQUENCE core.source_observations_observation_sequence_seq TO mpc_app;
CREATE TRIGGER source_observations_no_update BEFORE UPDATE ON core.source_observations
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER source_observations_no_delete BEFORE DELETE ON core.source_observations
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
CREATE TRIGGER source_observations_no_truncate BEFORE TRUNCATE ON core.source_observations
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

-- A tenant-scoped FK alone cannot stop an observation being attached to another project or
-- query within that tenant. Preserve the exact receipt boundary on every insertion path.
CREATE FUNCTION core.check_source_observation_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.source_receipts r
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.receipt_id
      AND r.project_id=NEW.project_id AND r.connection_id=NEW.connection_id
      AND r.query_basis=NEW.query_basis
      AND r.channel_evidence->>'collector'='server_adapter'
  ) OR (NEW.previous_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.source_receipts r
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.previous_receipt_id
      AND r.project_id=NEW.project_id AND r.connection_id=NEW.connection_id
      AND r.query_basis=NEW.query_basis AND r.result='confirmed_from_source'
  )) THEN
    RAISE EXCEPTION 'Observation must match its server-collected receipt scope'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION core.check_source_observation_scope() FROM PUBLIC;
CREATE TRIGGER source_observations_scope BEFORE INSERT ON core.source_observations
  FOR EACH ROW EXECUTE FUNCTION core.check_source_observation_scope();

-- Reports now read observation health as a live input. Direct application SQL must join
-- the publication barrier too, rather than relying only on the collection service's lock.
CREATE TRIGGER aaaa_ledger_publication_barrier BEFORE INSERT ON core.source_observations
  FOR EACH ROW EXECUTE FUNCTION core.guard_ledger_input_write('project');
