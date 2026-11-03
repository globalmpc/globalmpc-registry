import type postgres from "postgres";

/**
 * What the role an operator CLI connects as may do, read once and checked per CLI.
 *
 * The bootstrap and login-role CLIs both run over the migration connection, and both used to
 * fail late — on the first insert, or after half the role DDL — when that role was an admin
 * that is not a real superuser (Aurora's `rds_superuser`). Their needs differ, so each has its
 * own check over this one reading.
 */
export interface ConnectingRole {
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreaterole: boolean;
  /** `server_version_num`, e.g. 160004. */
  readonly serverVersionNum: number;
}

export async function readConnectingRole(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<ConnectingRole | undefined> {
  const [row] = await sql<
    { rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; server_version_num: string }[]
  >`
    SELECT rolsuper, rolbypassrls, rolcreaterole,
           current_setting('server_version_num') AS server_version_num
    FROM pg_roles WHERE rolname = current_user
  `;
  if (!row) return undefined;
  return {
    rolsuper: row.rolsuper,
    rolbypassrls: row.rolbypassrls,
    rolcreaterole: row.rolcreaterole,
    serverVersionNum: Number(row.server_version_num),
  };
}

/**
 * Why the role cannot work across tenants, or null if it can.
 *
 * Every tenant table forces row-level security, owner included. A role that cannot bypass it
 * fails on the first insert, or worse, passes a cross-tenant uniqueness check by seeing nothing.
 */
export function rlsBypassProblem(
  role: Pick<ConnectingRole, "rolsuper" | "rolbypassrls"> | undefined,
): string | null {
  if (role?.rolsuper || role?.rolbypassrls) return null;
  return (
    "The connecting role can neither bypass row-level security nor is it a superuser. " +
    "Connect with a role that has BYPASSRLS."
  );
}
