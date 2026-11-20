import postgres from "postgres";
import { runMigrations } from "./migrate.js";

const url = process.env["DATABASE_URL"];
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });
const executed = await runMigrations(sql);
if (process.env["DEPLOY_ENVIRONMENT"] === "develop" && process.env["CHAIN_ID"] === "5611") {
  await sql`INSERT INTO core.development_google_wallet_policy VALUES(true) ON CONFLICT DO NOTHING`;
} else {
  await sql`DELETE FROM core.development_google_wallet_policy`;
}
process.stdout.write(
  executed.length > 0 ? `Applied: ${executed.join(", ")}\n` : "No migrations to apply\n",
);
await sql.end();
