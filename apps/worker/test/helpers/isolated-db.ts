import postgres from "postgres";
import { runMigrations } from "@mpc/db";

/**
 * Connects to a database dedicated to this file.
 *
 * **The outbox query crosses tenant boundaries.** By design the worker publishes events for every
 * tenant (0012). Sharing a DB with another test file lets that file's rows fill the `LIMIT` first
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
