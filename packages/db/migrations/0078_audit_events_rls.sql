-- Tenant isolation on `audit.events` (02 §2.5, §2.7).
--
-- `0002` turned on RLS by looping over the `core` and `chain` schemas, so `audit.events` was
-- never included although it carries a `tenant_id` like every other tenant table. Every route
-- that reads it filters by tenant by hand; with the policy, a route that forgets the filter sees
-- nothing instead of another tenant's audit trail, and an insert cannot be filed under another
-- tenant.
--
-- Who writes and reads it, and why the policy holds for each:
-- - API (`mpc_app`): every `recordAudit` call and every read runs inside `withTenant` for the
--   same tenant it writes or filters by. Sign-in and sign-out write only when the session has a
--   tenant; there is no audit row without one (`tenant_id` is NOT NULL), so no NULL-tenant
--   exception is needed.
-- - Worker (`mpc_worker`, `outbox-replay`): BYPASSRLS, unaffected.
-- - Bootstrap and ops scripts: superuser, unaffected.
--
-- Same policy text as `0002`, so the table behaves like the rest.

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit.events
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
