import postgres from "postgres";
import { ensureLoginRoles, LoginRoleError } from "./login-roles.js";

/**
 * login role 생성 실행기.
 *
 * migration 다음, API·worker가 뜨기 전에 한 번 돌린다. 재실행해도 안전하다 —
 * 없으면 만들고, 있으면 비밀번호만 맞춘다.
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
  process.stderr.write(`환경변수가 없다 — ${missing.join(", ")}\n`);
  process.exit(1);
}

const sql = postgres(url as string, { onnotice: () => {} });

try {
  const { created } = await ensureLoginRoles(sql, {
    appPassword: appPassword as string,
    workerPassword: workerPassword as string,
  });
  // 비밀번호는 찍지 않는다. 무엇을 만들었는지만 남긴다.
  process.stdout.write(
    `${JSON.stringify({
      msg: "login-roles.ready",
      created,
    })}\n`,
  );
} catch (error) {
  const message = error instanceof LoginRoleError ? error.message : String(error);
  process.stderr.write(`login role 생성 실패 — ${message}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
