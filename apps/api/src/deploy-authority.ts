import type postgres from "postgres";

/** Deployment owns these objects; application and worker logins must not act as bootstrap. */
export async function requireDeploymentOwner(sql: postgres.Sql): Promise<void> {
  const [row] = await sql<{ allowed: boolean }[]>`
    SELECT count(*) = 3 AND bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) AS allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'core' AND c.relname IN ('tenants', 'subjects', 'service_tokens')
  `;
  if (!row?.allowed) throw new Error("Deployment management requires the migration table owner; application and worker connections are not allowed");
}
