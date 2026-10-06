import postgres from "postgres";
import { runMigrations } from "./migrate.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });
const executed = await runMigrations(sql);
process.stdout.write(
  executed.length > 0 ? `Applied: ${executed.join(", ")}\n` : "No migrations to apply\n",
);
await sql.end();
