import postgres from "postgres";
import { runMigrations } from "./migrate.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  process.stderr.write("DATABASE_URL이 필요하다\n");
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });
const executed = await runMigrations(sql);
process.stdout.write(
  executed.length > 0 ? `적용: ${executed.join(", ")}\n` : "적용할 마이그레이션 없음\n",
);
await sql.end();
