import type postgres from "postgres";

/**
 * Creates login roles that can connect.
 *
 * The `mpc_app` and `mpc_worker` roles created by migrations are NOLOGIN. They hold the
 * privilege boundary; the members that can connect are kept separate.
 *
 * **There is a reason this is code, not a SQL file.** Deployments cannot mount repository files
 * into containers — Coolify rewrites relative bind mounts in compose to absolute host paths,
 * and the repository is not at that path. Code running inside the same image needs no mount,
 * and since the `$$` PL/pgSQL block never passes through a shell, quoting problems disappear too.
 *
 * **Passwords are reset every time.** If creation were only attempted and skipped when the role
 * already exists, a password regenerated on redeploy would not take effect and the API could not
 * connect — and the cause would show up only as "authentication failed", making it hard to find.
 *
 * Called over a connection that bypasses RLS (superuser).
 */

export interface LoginRolePasswords {
  readonly appPassword: string;
  readonly workerPassword: string;
}

export class LoginRoleError extends Error {
  readonly code = "LOGIN_ROLE_INVALID";
}

const APP_LOGIN = "mpc_app_login";
const WORKER_LOGIN = "mpc_worker_login";

export async function ensureLoginRoles(
  sql: postgres.Sql,
  passwords: LoginRolePasswords,
): Promise<{ created: string[] }> {
  for (const [name, value] of [
    ["appPassword", passwords.appPassword],
    ["workerPassword", passwords.workerPassword],
  ] as const) {
    if (value.trim() === "") {
      throw new LoginRoleError(`${name} is empty`);
    }
  }

  const created: string[] = [];

  for (const [role, parent, password] of [
    [APP_LOGIN, "mpc_app", passwords.appPassword],
    [WORKER_LOGIN, "mpc_worker", passwords.workerPassword],
  ] as const) {
    const existing = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname = ${role}
    `;

    if (existing.length === 0) {
      // Role names are constants, so there is no identifier-injection path. Passwords are passed
      // as parameters below — never concatenated into strings.
      await sql.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ${parent}`);
      created.push(role);
    }

    // `ALTER ROLE ... PASSWORD` does not accept parameter binding. String concatenation
    // breaks on passwords containing quotes, so the server's `format` builds an escaped
    // statement that is then executed. Without the `::text` cast the server cannot
    // determine the parameter type.
    const [built] = await sql<{ statement: string }[]>`
      SELECT format('ALTER ROLE %I WITH PASSWORD %L', ${role}::text, ${password}::text)
        AS statement
    `;
    if (!built) throw new LoginRoleError("Failed to build the ALTER ROLE statement");

    /**
     * This statement carries the password in plain text.
     *
     * If `log_statement` is `ddl` or `all` it lands in the DB log as is, and logs are usually
     * read more widely than secrets. Statement logging is off only for this transaction — it is
     * session-scoped, so other connections' settings are untouched, and it reverts when the transaction ends.
     *
     * `SET LOCAL` only has meaning inside a transaction, so it is wrapped in one.
     */
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL log_statement = 'none'");
      await tx.unsafe(built.statement);
    });
  }

  await sql.unsafe(
    `GRANT USAGE ON SCHEMA core, chain, audit TO ${APP_LOGIN}, ${WORKER_LOGIN}`,
  );

  // The worker is a system process that spans tenants (0012). It bypasses RLS, but the bypass
  // is limited to the privileges granted to mpc_worker.
  await sql.unsafe(`ALTER ROLE ${WORKER_LOGIN} BYPASSRLS`);

  return { created };
}
