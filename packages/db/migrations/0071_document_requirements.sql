-- Document requirements — which document types a project expects, and how much each one matters.
--
-- A mining project gathers thousands of documents. People preparing them need to see, per
-- project, which ones are required, which ones are only worth having, which ones have expired and
-- which ones were replaced. 0045 gave every upload a type, a validity date and a predecessor; what
-- it did not record is what the project expects. Without that, "is anything required missing"
-- has no answer.
--
-- **The list is the project's, not the code's.** There is no settled catalog of document types
-- (OD-46), so no type is required by default. The people who run a project's Data Room declare
-- the types they expect and the tier each one sits in. A declaration is retired with a reason,
-- never deleted, so "why was this not required last month" still has an answer.
--
-- **Tiers.** `required` is the only tier that can leave a project incomplete. The other three say
-- why a document is worth having without making it a gap: it helps the people reading the
-- project (`user_benefit`), it makes the project easier to present (`presentation`), or it makes
-- the project easier to run (`management`).

CREATE TYPE core.document_requirement_tier AS ENUM (
  'required',
  'user_benefit',
  'presentation',
  'management'
);

CREATE TABLE core.document_requirements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  project_id      UUID NOT NULL,
  /** Compared case-insensitively with `object_uploads.document_type`, like the type rules. */
  document_type   TEXT NOT NULL,
  tier            core.document_requirement_tier NOT NULL,
  note            TEXT,
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ,
  retired_by      UUID,
  retirement_note TEXT,

  -- Same shape as `object_uploads.document_type`, so a declared type can always be matched.
  CONSTRAINT document_requirement_type_shape CHECK (
    document_type = btrim(document_type) AND length(document_type) BETWEEN 1 AND 80
  ),
  CONSTRAINT document_requirement_note_shape CHECK (
    note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500
  ),
  CONSTRAINT document_requirement_retirement_complete CHECK (
    (retired_at IS NULL AND retired_by IS NULL AND retirement_note IS NULL)
    OR (retired_at IS NOT NULL AND retired_by IS NOT NULL
        AND length(btrim(coalesce(retirement_note, ''))) > 0)
  ),
  CONSTRAINT document_requirement_tenant_scope_key UNIQUE (tenant_id, id),
  -- FK checks bypass RLS, so the keys carry the tenant.
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES core.subjects (tenant_id, id),
  FOREIGN KEY (tenant_id, retired_by) REFERENCES core.subjects (tenant_id, id)
);

-- One active declaration per type and project. Two tiers for one type would give two answers to
-- "is this required".
CREATE UNIQUE INDEX document_requirements_active_type
  ON core.document_requirements (tenant_id, project_id, lower(document_type))
  WHERE retired_at IS NULL;

/** Retiring is the only change; the declaration itself stays as written. */
CREATE OR REPLACE FUNCTION core.protect_document_requirement() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A document requirement cannot be deleted. Retire it with a reason';
  END IF;

  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'A retired document requirement cannot be changed';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.document_type IS DISTINCT FROM OLD.document_type
     OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'A document requirement is changed by retiring it and declaring a new one';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER document_requirements_protect
  BEFORE UPDATE OR DELETE ON core.document_requirements
  FOR EACH ROW EXECUTE FUNCTION core.protect_document_requirement();

-- The status summary groups a project's documents by type. Without this, every summary of a
-- 10,000-document project would sort the whole project by a computed key.
CREATE INDEX object_uploads_project_type_idx
  ON core.object_uploads (project_id, lower(document_type));

-- The document list pages by (uploaded_at, id). 0007's index lacks the tie-breaker, and
-- uploads in one batch can share a timestamp.
CREATE INDEX object_uploads_project_page_idx
  ON core.object_uploads (project_id, uploaded_at DESC, id DESC);

-- The page index above starts with (project_id, uploaded_at DESC), so the 0007 index on exactly
-- those columns only adds write cost.
DROP INDEX core.object_uploads_project_idx;

-- "Was this replaced" is asked of every document in a summary.
CREATE INDEX object_uploads_supersedes_idx
  ON core.object_uploads (supersedes_upload_id) WHERE supersedes_upload_id IS NOT NULL;

/**
 * Where each upload stands, in one word.
 *
 * Defined once here so the summary and the list cannot disagree. Checked in this order:
 *
 * - `unusable`   — failed scanning or was rejected. Nobody relies on it.
 * - `superseded` — a promoted newer version replaced it. Kept, not deleted.
 * - `pending`    — not promoted yet (received, in quarantine, or scanned clean).
 * - `expired`    — promoted, and its last valid day is before today.
 * - `current`    — promoted, not replaced, and valid today (or has no validity date).
 *
 * "Today" is the database's calendar day, the same one the expiry sweep in 0045 uses — a
 * document valid until 2026-09-30 is still valid on that day.
 *
 * `security_invoker` makes the view read with the caller's rights, so tenant isolation on
 * `object_uploads` still applies. Without it the view would read as its owner and cross tenants.
 */
CREATE VIEW core.document_status WITH (security_invoker = true) AS
SELECT
  u.tenant_id,
  u.project_id,
  u.id AS upload_id,
  u.document_type,
  lower(u.document_type) AS type_key,
  u.valid_until,
  (u.valid_until - current_date) AS days_until_expiry,
  u.state,
  u.uploaded_at,
  u.original_filename,
  u.version,
  CASE
    WHEN u.state IN ('scanned_infected', 'rejected') THEN 'unusable'
    WHEN EXISTS (
      SELECT 1 FROM core.object_uploads s
      WHERE s.supersedes_upload_id = u.id AND s.state = 'promoted'
    ) THEN 'superseded'
    WHEN u.state <> 'promoted' THEN 'pending'
    WHEN u.valid_until < current_date THEN 'expired'
    ELSE 'current'
  END AS status
FROM core.object_uploads u;

GRANT SELECT ON core.document_status TO mpc_app;

ALTER TABLE core.document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.document_requirements FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON core.document_requirements
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

-- Never deleted; retiring is an update.
GRANT SELECT, INSERT, UPDATE ON core.document_requirements TO mpc_app;
