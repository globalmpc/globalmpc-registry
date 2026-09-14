-- login roles for the local stack.
--
-- `mpc_app` and `mpc_worker` created by migrations are NOLOGIN. Separate members that can
-- connect are added — the privilege boundary stays as is; only connecting becomes possible.
--
-- Real deployments do not use this file. IAM or a secret manager manages credentials, and
-- passwords never enter the repository.

DO $$
BEGIN
  CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE mpc_worker_login LOGIN PASSWORD 'worker' IN ROLE mpc_worker;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login, mpc_worker_login;

-- The worker is a system process that spans multiple tenants (0012). It bypasses RLS, but
-- the bypass is limited to the privileges granted to mpc_worker.
ALTER ROLE mpc_worker_login BYPASSRLS;
