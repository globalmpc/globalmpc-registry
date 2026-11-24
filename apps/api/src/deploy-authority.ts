import type postgres from "postgres";

/**
 * Deployment owns these objects; application and worker logins must not act as bootstrap.
 *
 * The owner must also bypass row-level security. Every table forces it, and the Registry has no
 * deployment-wide context to set: rows are reached through an actor's role bindings, and bootstrap
 * creates the first actor. The definer functions this owner owns already require the same
 * (0131), so a deployment whose owner cannot bypass cannot sign anyone in either.
 */
export async function requireDeploymentOwner(sql: postgres.Sql): Promise<void> {
  const [row] = await sql<{ allowed: boolean; bypass: boolean }[]>`
    SELECT count(*) = 3 AND bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) AS allowed,
           (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'core' AND c.relname IN ('role_bindings', 'subjects', 'service_tokens')
  `;
  if (!row?.allowed) throw new Error("Deployment management requires the migration table owner; application and worker connections are not allowed");
  if (!row.bypass) {
    throw new Error("Deployment management requires an owner that bypasses row-level security (superuser or BYPASSRLS), as the migration owner already must");
  }
}
