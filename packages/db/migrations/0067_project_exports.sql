-- Project export package — spec 07 §7.9.
--
-- `POST /projects/{id}/exports` is an asynchronous job. The request row is written with the
-- `project.export.requested` outbox event in one transaction; the outbox worker builds the
-- package and stores it here. A failed build is retried by the outbox and, once dead-lettered,
-- the job is marked `failed` — never left looking queued.
--
-- **The requester's clearance is frozen on the job.** Redaction follows what the requester
-- could read when asking (07 §7.9 "redacted by access right"), not what the worker could read.
-- The package is served back only to the requester, so a package built for one clearance is
-- never read under another.
--
-- **The package holds metadata, hashes and public projections only.** Raw source bytes,
-- findings, citations and object keys are never copied here; they stay behind their own reads.

CREATE TABLE core.project_exports (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  project_id             UUID NOT NULL,
  requested_by_subject_id UUID NOT NULL REFERENCES core.subjects(id),
  requested_by_wallet    TEXT NOT NULL,
  sensitivity_clearance  TEXT[] NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'queued'
                           CHECK (state IN ('queued', 'succeeded', 'failed')),
  package                JSONB,
  -- sha256 of the canonical (JCS) package manifest.
  manifest_hash          TEXT CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  failure_reason         TEXT,
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,

  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  CONSTRAINT export_package_on_success CHECK (
    (state = 'succeeded') = (package IS NOT NULL AND manifest_hash IS NOT NULL)
  ),
  CONSTRAINT export_completion CHECK ((state = 'queued') = (completed_at IS NULL))
);

CREATE INDEX project_exports_requester_idx
  ON core.project_exports (tenant_id, project_id, requested_by_subject_id, requested_at DESC);

ALTER TABLE core.project_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_exports FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.project_exports
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- The API creates and reads jobs; it never writes a package.
GRANT SELECT, INSERT ON core.project_exports TO mpc_app;

-- The worker completes jobs and reads exactly the records a package is built from. This is
-- the first domain read the worker gets; it is limited to these tables and grants no writes
-- to them.
GRANT SELECT, UPDATE ON core.project_exports TO mpc_worker;
GRANT SELECT ON
  core.projects,
  core.registry_entries,
  core.registry_entry_versions,
  core.verification_cases,
  core.verification_attestations,
  core.source_receipts,
  core.gate_decisions
TO mpc_worker;
