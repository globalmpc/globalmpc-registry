-- Append-only transport observations do not modify approvals, readiness or anchored bytes.
CREATE TABLE core.cre_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id UUID NOT NULL REFERENCES core.tenants(id),
  project_id UUID NOT NULL,
  registry_version_id UUID NOT NULL,
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object' AND report ->> 'sequence' IS NOT NULL
    AND report ->> 'sequence' ~ '^[1-9][0-9]{0,19}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,project_id) REFERENCES core.projects(tenant_id,id),
  FOREIGN KEY (tenant_id,registry_version_id) REFERENCES core.registry_entry_versions(tenant_id,id)
);
CREATE INDEX cre_reports_project_idx ON core.cre_reports(tenant_id,project_id,sequence DESC);
CREATE UNIQUE INDEX cre_reports_public_sequence_idx ON core.cre_reports(tenant_id,project_id,(report ->> 'sequence'));
ALTER TABLE core.cre_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.cre_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.cre_reports
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());
GRANT SELECT, INSERT ON core.cre_reports TO mpc_app;
GRANT USAGE ON SEQUENCE core.cre_reports_sequence_seq TO mpc_app;
CREATE TRIGGER cre_reports_no_mutation BEFORE UPDATE OR DELETE ON core.cre_reports
  FOR EACH ROW EXECUTE FUNCTION core.reject_history_mutation();
CREATE TRIGGER cre_reports_no_truncate BEFORE TRUNCATE ON core.cre_reports
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();
-- Direct SQL inserts must join the same project barrier as API sequence allocation.
CREATE TRIGGER aaaa_ledger_publication_barrier BEFORE INSERT ON core.cre_reports
  FOR EACH ROW EXECUTE FUNCTION core.guard_ledger_input_write('project');

-- Composite tenant FKs alone do not establish that a version belongs to this project.
CREATE FUNCTION core.check_cre_report_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id=v.entry_id AND e.tenant_id=v.tenant_id
    WHERE v.tenant_id=NEW.tenant_id AND v.id=NEW.registry_version_id
      AND e.registry_type='project' AND e.subject_id=NEW.project_id
      AND v.published_at IS NOT NULL AND v.status IN ('published','revoked','superseded')
      AND v.content_hash=NEW.report ->> 'contentHash'
      AND v.version::text=NEW.report ->> 'registryVersion'
  ) THEN
    RAISE EXCEPTION 'CRE report must reference its approved project version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION core.check_cre_report_scope() FROM PUBLIC;
CREATE TRIGGER cre_reports_scope BEFORE INSERT ON core.cre_reports
  FOR EACH ROW EXECUTE FUNCTION core.check_cre_report_scope();
