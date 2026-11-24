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
 * Why row-level security still applies to the connecting role, or null if it does not.
 *
 * Every Registry table forces row-level security, owner included. A role it applies to fails on
 * the first insert, or worse, passes a Registry-wide uniqueness check by seeing nothing.
 *
 * Checked by behaviour, as migration 0169 does, not by role attribute: superuser and BYPASSRLS are
 * the documented ways, but a managed master role (the develop Aurora `postgres`) can be exempt
 * without either. Every RLS table in core/chain/audit is read with `row_security = off`, which
 * PostgreSQL refuses (42501) on a table whose policies would apply to the role. The exemption is
 * per table (FORCE is set per table), so every table is probed, not a chosen few.
 */
export async function rlsExemptionProblem(sql: postgres.Sql): Promise<string | null> {
  try {
    await sql.begin((tx) => tx.unsafe(PROBE_EVERY_RLS_TABLE));
    return null;
  } catch (error) {
    if ((error as { code?: string }).code !== "42501") throw error;
    return `Row-level security still applies to the connecting role (it is neither exempt nor superuser or BYPASSRLS); ${(error as Error).message}`;
  }
}

const PROBE_EVERY_RLS_TABLE = `DO $$
DECLARE
  t RECORD;
  refused TEXT[] := '{}';
BEGIN
  PERFORM set_config('row_security', 'off', true);
  FOR t IN
    SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core', 'chain', 'audit') AND c.relkind IN ('r', 'p') AND c.relrowsecurity
    ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM %s LIMIT 1', t.rel);
    EXCEPTION WHEN insufficient_privilege THEN
      refused := refused || t.rel::text;
    END;
  END LOOP;
  IF cardinality(refused) > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('row-level security applies on %s table(s): %s', cardinality(refused), array_to_string(refused[1:10], ', '));
  END IF;
END
$$`;
