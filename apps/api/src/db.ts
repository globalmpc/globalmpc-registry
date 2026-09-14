import postgres from "postgres";
import type { AppConfig } from "./config.js";

/**
 * Connection factory.
 *
 * The application connects as the `mpc_app` role. Connecting as superuser bypasses RLS
 * (BYPASSRLS) and tenant isolation does not hold — 02 §2.5.
 */
export function createDb(config: AppConfig): postgres.Sql {
  return postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 30,
    // If values mix into query text, PII ends up in logs.
    onnotice: () => {},
  });
}
