-- The scan worker scans for one tenant — account authentication WP1.
--
-- Its service token belongs to one tenant, and the API refuses a scan report for another tenant's
-- upload (404). A worker leasing every tenant's uploads would scan files it can never report and
-- burn their attempts. The worker resolves its tenant from `SCAN_SERVICE_TENANT_SLUG` (the slug its
-- token was registered for) and leases only that tenant's uploads, so it needs to read the slug and
-- the id — and nothing else of the tenant row.

GRANT SELECT (id, slug) ON core.tenants TO mpc_worker;
