-- The project owns an export job and supplies its scope. Keep RLS in force by
-- requiring the owning project to be visible to the runtime role.
CREATE POLICY project_export_owner_scope ON core.project_exports
  USING (EXISTS (
    SELECT FROM core.projects AS project WHERE project.id = project_exports.project_id
  ))
  WITH CHECK (EXISTS (
    SELECT FROM core.projects AS project WHERE project.id = project_exports.project_id
  ));

DROP POLICY tenant_isolation ON core.project_exports;
ALTER TABLE core.project_exports
  ADD CONSTRAINT project_exports_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.project_exports DROP COLUMN tenant_id;
CREATE INDEX project_exports_requester_idx
  ON core.project_exports (project_id, requested_by_subject_id, requested_at DESC);

-- Deployments run migrations before the API and worker roll. Older tasks can
-- keep using their relation name and column shape during that window.
ALTER TABLE core.project_exports RENAME TO project_export_jobs;
CREATE VIEW core.project_exports WITH (security_invoker = true) AS
  SELECT job.*,
    (SELECT project.tenant_id FROM core.projects AS project WHERE project.id = job.project_id) AS tenant_id
  FROM core.project_export_jobs AS job;

GRANT SELECT, INSERT ON core.project_exports TO mpc_app;
GRANT SELECT, UPDATE ON core.project_exports TO mpc_worker;

CREATE FUNCTION core.insert_legacy_project_export() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, core, pg_temp AS $$
DECLARE
  job core.project_export_jobs;
BEGIN
  INSERT INTO core.project_export_jobs (
    id, project_id, requested_by_subject_id, requested_by_wallet, sensitivity_clearance
  )
  SELECT NEW.id, project.id, NEW.requested_by_subject_id, NEW.requested_by_wallet,
         NEW.sensitivity_clearance
  FROM core.projects AS project
  WHERE project.id = NEW.project_id AND project.tenant_id = NEW.tenant_id
  RETURNING * INTO job;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project export owner does not match project' USING ERRCODE = '23503';
  END IF;

  SELECT job.*, NEW.tenant_id INTO NEW;
  RETURN NEW;
END
$$;

CREATE TRIGGER insert_legacy_project_export
INSTEAD OF INSERT ON core.project_exports
FOR EACH ROW EXECUTE FUNCTION core.insert_legacy_project_export();
