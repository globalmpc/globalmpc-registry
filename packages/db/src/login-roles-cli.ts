import postgres from "postgres";
import { ensureLoginRoles, LoginRoleError } from "./login-roles.js";

/**
 * Login role creation runner.
 *
 * Run once after migrations, before the API and worker start. Safe to re-run —
 * creates the roles if missing, and otherwise only resets their passwords.
 */

const url = process.env["DATABASE_URL"];
const appPassword = process.env["APP_DB_PASSWORD"];
const workerPassword = process.env["WORKER_DB_PASSWORD"];

const missing = [
  ["DATABASE_URL", url],
  ["APP_DB_PASSWORD", appPassword],
  ["WORKER_DB_PASSWORD", workerPassword],
]
  .filter(([, value]) => (value ?? "") === "")
  .map(([name]) => name);

if (missing.length > 0) {
  process.stderr.write(`Missing environment variables — ${missing.join(", ")}\n`);
  process.exit(1);
}

const sql = postgres(url as string, { onnotice: () => {} });

try {
  const { created } = await ensureLoginRoles(sql, {
    appPassword: appPassword as string,
    workerPassword: workerPassword as string,
  });
  // Never print passwords. Record only what was created.
  process.stdout.write(
    `${JSON.stringify({
      msg: "login-roles.ready",
      created,
    })}\n`,
  );
} catch (error) {
  const message = error instanceof LoginRoleError ? error.message : String(error);
  process.stderr.write(`Login role creation failed — ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
