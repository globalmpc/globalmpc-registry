import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";

/**
 * Connects to a database dedicated to this file.
 *
 * **The outbox query crosses project boundaries.** By design the worker publishes events for every
 * project (0012). Sharing a DB with another test file lets that file's rows fill the `LIMIT` first
 * and push this file's rows out of the batch — an intermittent failure where publishing works but
 * the assertion breaks.
 *
 * Do not narrow the production global scope for test convenience — that would make what the worker
 * sees differ between tests and production. Split the DB instead.
 */
export async function connectIsolated(suffix: string): Promise<postgres.Sql> {
  const base = process.env["DATABASE_URL"];
  if (!base) throw new Error("DATABASE_URL is required");

  const url = new URL(base);
  const database = `${decodeURIComponent(url.pathname.slice(1))}_${suffix}`;

  const admin = postgres(base, { onnotice: () => {}, max: 1 });
  try {
    // CREATE DATABASE cannot be parameterized. suffix is a literal from the caller.
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } catch (error) {
    // 42P04 = duplicate_database. Reuse it if it already exists.
    if ((error as { code?: string }).code !== "42P04") throw error;
  } finally {
    await admin.end();
  }

  url.pathname = `/${encodeURIComponent(database)}`;
  const sql = postgres(url.toString(), { onnotice: () => {} });
  await runMigrations(sql);

  // Unpublished rows left by an earlier run would push out this run's batch. Isolated for the same
  // reason, so start from an empty state too.
  await sql`TRUNCATE core.outbox, core.inbox`;

  return sql;
}

/** Execute against a real deployment-style login with inherited grants and RLS enforced. */
export async function asWorker<T>(
  admin: postgres.Sql,
  body: (worker: postgres.Sql) => Promise<T>,
): Promise<T> {
  const [database] = await admin<{ name: string }[]>`SELECT current_database() AS name`;
  const url = new URL(process.env["DATABASE_URL"]!);
  const login = `jobs_rls_${randomUUID().replaceAll("-", "")}`;
  const password = randomUUID();
  url.pathname = `/${encodeURIComponent(database!.name)}`;
  url.username = login;
  url.password = password;
  await admin.unsafe(`CREATE ROLE "${login}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}' IN ROLE mpc_worker`);
  const worker = postgres(url.href, { onnotice: () => {} });
  try {
    const [role] = await worker`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (role?.rolname !== login || role.rolsuper !== false || role.rolbypassrls !== false) {
      throw new Error("Worker regression must run with RLS enforced");
    }
    return await body(worker);
  } finally {
    await worker.end();
    await admin.unsafe(`DROP ROLE "${login}"`);
  }
}
