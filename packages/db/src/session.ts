import type postgres from "postgres";

/**
 * Tenant session context.
 *
 * 02 §2.5: every query runs inside a tenant scope. RLS policies read
 * `app.current_tenant`, so a query that does not go through this function sees no rows.
 * The default being "nothing" rather than "allow everything" is intentional.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly projectId?: string;
}

export async function withTenant<T>(
  sql: postgres.Sql,
  context: TenantContext,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant', ${context.tenantId}, true)`;
    if (context.projectId !== undefined) {
      await tx`SELECT set_config('app.current_project', ${context.projectId}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}
