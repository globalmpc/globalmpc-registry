-- Upload tracking and quarantine — 12 §12.2 "encrypted object upload·quarantine".
--
-- An upload does not become evidence immediately. It enters quarantine and must pass scanning
-- to be promoted to an artifact (06 §6.7 "malware quarantine"). Otherwise a malicious
-- file would become material for expert review.

CREATE TYPE core.upload_state AS ENUM (
  'received',
  'quarantined',
  'scanned_clean',
  'scanned_infected',
  'promoted',
  'rejected'
);

CREATE TABLE core.object_uploads (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  project_id    UUID NOT NULL,
  -- The storage key contains no file or project name. Keys flow through logs, URLs, and error
  -- messages, and document titles must not leak into the public projection (§11.9).
  object_key    TEXT NOT NULL,
  content_hash  TEXT NOT NULL CHECK (content_hash ~ '^0x[0-9a-f]{64}$'),
  byte_size     BIGINT NOT NULL CHECK (byte_size > 0),
  content_type  TEXT NOT NULL,
  -- The original file name lives in a separate column and is treated as restricted. Display
  -- also requires passing the public projection allowlist.
  original_filename TEXT,
  sensitivity   core.sensitivity NOT NULL,
  state         core.upload_state NOT NULL DEFAULT 'received',
  uploaded_by   UUID,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_at    TIMESTAMPTZ,
  promoted_artifact_id UUID,
  rejection_reason TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, object_key),
  -- Uploading the same content twice yields the same hash. Blocks duplicate uploads within
  -- a tenant and project so evidence does not fork.
  UNIQUE (tenant_id, project_id, content_hash),
  CONSTRAINT promoted_requires_artifact CHECK (
    state <> 'promoted' OR promoted_artifact_id IS NOT NULL
  ),
  CONSTRAINT rejected_requires_reason CHECK (
    state <> 'rejected' OR btrim(coalesce(rejection_reason, '')) <> ''
  ),
  CONSTRAINT upload_tenant_scope_key UNIQUE (tenant_id, id)
);

-- Blocks references across the tenant boundary (same rule as 0006).
ALTER TABLE core.object_uploads
  ADD CONSTRAINT object_uploads_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  ADD CONSTRAINT object_uploads_uploader_same_tenant
    FOREIGN KEY (tenant_id, uploaded_by) REFERENCES core.subjects (tenant_id, id),
  ADD CONSTRAINT object_uploads_artifact_same_tenant
    FOREIGN KEY (tenant_id, promoted_artifact_id) REFERENCES core.artifacts (tenant_id, id);

ALTER TABLE core.object_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.object_uploads FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.object_uploads
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT, UPDATE ON core.object_uploads TO mpc_app;

CREATE INDEX object_uploads_project_idx ON core.object_uploads (project_id, uploaded_at DESC);
CREATE INDEX object_uploads_quarantine_idx ON core.object_uploads (state)
  WHERE state IN ('received', 'quarantined');

-- Upload records are never deleted. Bad uploads remain in the rejected state —
-- what was uploaded is subject to audit.
CREATE TRIGGER object_upload_no_delete
  BEFORE DELETE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- content_hash and object_key do not change after storage. A change would make the
-- stored object and the DB record diverge.
CREATE OR REPLACE FUNCTION core.protect_upload_identity() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.byte_size  IS DISTINCT FROM OLD.byte_size
     OR NEW.tenant_id  IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
  THEN
    RAISE EXCEPTION '업로드된 객체의 식별 정보는 수정할 수 없다. 새 업로드로 처리한다'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER object_upload_identity_immutable
  BEFORE UPDATE ON core.object_uploads
  FOR EACH ROW EXECUTE FUNCTION core.protect_upload_identity();
