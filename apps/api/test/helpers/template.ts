import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import { TEST_ELEVATION_SQL } from "./elevation-sql.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The migrated database every API fixture clones; empty without `DATABASE_URL`. */
    apiTemplate: string;
  }
}

/** Migrates the template once per test process; a stale template is rebuilt. */
export async function prepareTemplate(admin: postgres.Sql, base: URL): Promise<string> {
  const template = `${decodeURIComponent(base.pathname.slice(1))}_api_template`.replace(/[^a-z0-9_]/gi, "_").slice(0, 60);
  const url = new URL(base);
  url.pathname = `/${template}`;
  const ensure = async (): Promise<void> => {
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${template}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE "${template}"`);
    const sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });
    try {
      await runMigrations(sql);
      await sql.unsafe(`
        DO $$
        BEGIN
          CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END
        $$;
        GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login;
      `);
      await sql.unsafe(TEST_ELEVATION_SQL);
    } finally {
      await sql.end();
    }
  };
  // Serial with any other process preparing the same template.
  await admin`SELECT pg_advisory_lock(hashtextextended(${template}, 0))`;
  try {
    try {
      await ensure();
    } catch {
      // Applied migrations whose files changed: rebuild from scratch.
      await admin.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
      await ensure();
    }
  } finally {
    await admin`SELECT pg_advisory_unlock(hashtextextended(${template}, 0))`;
  }
  return template;
}

