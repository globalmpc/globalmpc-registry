-- Row-level security — tenant isolation
--
-- 02 §2.5 / 06 §6.8: tenant data is separated logically, by permission, and by encryption key.
--
-- Important: RLS enforces **only the tenant boundary**. Role, sensitivity, assignment, conflict,
-- and resource state — all 7 conditions of 02 §2.1 — are evaluated by the application
-- authorization layer. Passing RLS is not passing authorization.
--
-- Session variables are set at the start of every request transaction:
--   SET LOCAL app.current_tenant = '<uuid>';
-- If unset, no rows are visible. A default of "allow all" would turn a missing
-- setting into a silent data leak.

-- Roles are cluster-wide objects. Another DB in the same cluster may already have created it,
-- so creation is idempotent.
DO $$
BEGIN
  CREATE ROLE mpc_app NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app;

CREATE OR REPLACE FUNCTION core.current_tenant() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT c.relname, n.nspname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = n.nspname
     AND col.table_name = c.relname
     AND col.column_name = 'tenant_id'
    WHERE n.nspname IN ('core', 'chain')
      AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.nspname, target.relname);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', target.nspname, target.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = core.current_tenant()) '
      'WITH CHECK (tenant_id = core.current_tenant())',
      target.nspname, target.relname
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON %I.%I TO mpc_app',
      target.nspname, target.relname
    );
  END LOOP;
END
$$;

-- Child tables without tenant_id are reachable only through their parent table's RLS.
GRANT SELECT, INSERT ON chain.anchor_batch_leaves TO mpc_app;
GRANT SELECT, INSERT ON core.inbox TO mpc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, chain, audit TO mpc_app;
