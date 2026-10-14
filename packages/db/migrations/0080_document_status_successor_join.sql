-- Resolve promoted successors with a join rather than a correlated EXISTS per status filter.
-- Aggregates inline the view's CASE for every count, repeating successor lookups. With stale
-- statistics after a bulk upload, those lookups can scan the upload table once per document
-- and make a 10,000-document summary exceed a minute. A join lets PostgreSQL resolve the
-- successor relation once for the query, including with a hash join when scans are cheaper.
--
-- object_uploads_one_live_successor permits at most one promoted successor per predecessor,
-- so the join cannot duplicate documents. Both sides retain the caller's tenant RLS; explicit
-- tenant/project equality also preserves scope. Status precedence and the view columns stay
-- the same. Existing migration checksums remain untouched.

CREATE OR REPLACE VIEW core.document_status WITH (security_invoker = true) AS
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
LEFT JOIN core.object_uploads s
  ON s.supersedes_upload_id = u.id
 AND s.tenant_id = u.tenant_id
 AND s.project_id = u.project_id
 AND s.state = 'promoted';
