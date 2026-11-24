import type postgres from "postgres";
import { rlsExemptionProblem } from "@mpc/db";

/**
 * Deployment owns these objects; application and worker logins must not act as bootstrap.
 *
 * Row-level security must also not apply to the owner. Every table forces it, and the Registry has
 * no deployment-wide context to set: rows are reached through an actor's role bindings, and
 * bootstrap creates the first actor. The definer functions this owner owns already require the
 * same (0131), so a deployment whose owner RLS filters cannot sign anyone in either.
 *
 * Checked by behaviour, as migration 0169 does: superuser and BYPASSRLS are the documented ways,
 * but a managed master role (the develop Aurora `postgres`) can be exempt without either
 * attribute. A read with `row_security = off` succeeds only when RLS does not apply to the role on
 * that table; PostgreSQL refuses it (42501) otherwise. The exemption is per table (FORCE is set per
 * table), and these callers read history across many of them — bootstrap's first-holder decision
 * reads moved-away addresses in `core.email_change_requests`, for one — so every RLS table in
 * core/chain/audit is probed, as 0169 does, not only the three this checks ownership of.
 */
export async function requireDeploymentOwner(sql: postgres.Sql): Promise<void> {
  const [row] = await sql<{ allowed: boolean }[]>`
    SELECT count(*) = 3 AND bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) AS allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'core' AND c.relname IN ('role_bindings', 'subjects', 'service_tokens')
  `;
  if (!row?.allowed) throw new Error("Deployment management requires the migration table owner; application and worker connections are not allowed");
  const problem = await rlsExemptionProblem(sql);
  if (problem) {
    throw new Error(`Deployment management requires an owner that row-level security does not apply to (superuser or BYPASSRLS), as the migration owner already must; ${problem}`);
  }
}
