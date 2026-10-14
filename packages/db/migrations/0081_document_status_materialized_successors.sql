-- Bulk uploads can arrive before autovacuum refreshes the table statistics. Even the join
-- introduced in 0080 can then choose a nested loop that rescans all uploads per document.
-- Materialize only promoted successors once, before joining them to the documents. Ordinary
-- uploads have no predecessor and never enter this intermediate set. RLS still filters both
-- inputs with the caller's tenant; uniqueness and status precedence are unchanged.

CREATE OR REPLACE VIEW core.document_status WITH (security_invoker = true) AS
WITH successors AS MATERIALIZED (
  SELECT id, tenant_id, project_id, supersedes_upload_id
  FROM core.object_uploads
  WHERE supersedes_upload_id IS NOT NULL AND state = 'promoted'
)
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
    WHEN s.id IS NOT NULL THEN 'superseded'
    WHEN u.state <> 'promoted' THEN 'pending'
    WHEN u.valid_until < current_date THEN 'expired'
    ELSE 'current'
  END AS status
FROM core.object_uploads u
LEFT JOIN successors s
  ON s.supersedes_upload_id = u.id
 AND s.tenant_id = u.tenant_id
 AND s.project_id = u.project_id;
