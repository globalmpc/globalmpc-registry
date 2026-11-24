import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@mpc/db";
import { bootstrapOperator } from "../src/bootstrap.js";
import { ensureServiceToken, generateServiceTokenValue } from "../src/service-tokens.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("deployment management needs an owner that bypasses FORCE RLS", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const db = `bs_scope_${suffix}`;
  const restricted = `bs_owner_${suffix}`;
  const bypassing = `bs_bypass_${suffix}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const input = (email = `${randomUUID()}@example.com`) => ({
    organizationName: "Operator", jurisdiction: "MNG",
    subjectName: "Operator", email, role: "administrator", assuranceLevel: "high_assurance" as const,
  });
  const token = () => ({ label: "scan-worker", role: "scan_service", scopes: ["scan_result"], token: generateServiceTokenValue(), ttlSeconds: 3600, overlapSeconds: 0 });
  beforeAll(async () => {
    admin = postgres(process.env["DATABASE_URL"]!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${db}`);
    await admin.unsafe(`CREATE ROLE ${restricted} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.unsafe(`CREATE ROLE ${bypassing} NOLOGIN NOSUPERUSER BYPASSRLS IN ROLE ${restricted}`);
    const url = new URL(process.env["DATABASE_URL"]!); url.pathname = `/${db}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await runMigrations(sql);
    // Model a managed migration owner, including functions it created. No runtime grants change.
    const tables = await sql`SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('core','chain','audit') AND c.relkind IN ('r','p')`;
    await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA core, chain, audit TO ${restricted}`);
    for (const t of tables) await sql.unsafe(`ALTER TABLE "${t.nspname}"."${t.relname}" OWNER TO ${restricted}`);
    const funcs = await sql`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('core','chain','audit')`;
    for (const f of funcs) await sql.unsafe(`ALTER FUNCTION ${f.signature} OWNER TO ${restricted}`);
  }, 120_000);
  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${bypassing}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${restricted}`);
      await admin.end();
    }
  });
  async function as<T>(role: string, work: () => Promise<T>): Promise<T> {
    await sql.unsafe(`SET ROLE ${role}`);
    try { return await work(); } finally { await sql`RESET ROLE`; }
  }

  it("refuses an owner that does not bypass, before writing anything", async () => {
    const [role] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${restricted}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await as(restricted, async () => {
      await expect(bootstrapOperator(sql, input())).rejects.toThrow(/bypasses row-level security/);
      await expect(ensureServiceToken(sql, token())).rejects.toThrow(/bypasses row-level security/);
    });
    expect(await sql`SELECT 1 FROM core.subjects`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM core.organizations`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM core.service_tokens`).toHaveLength(0);
  });

  it("bootstraps, reruns and registers a service token under an owner that bypasses", async () => {
    const [role] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${bypassing}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: true });
    const args = input();
    await as(bypassing, async () => {
      const first = await bootstrapOperator(sql, args);
      expect(first.created).toBe(true);
      expect(await bootstrapOperator(sql, args)).toMatchObject({ subjectId: first.subjectId, created: false });
      // The Registry already has a first holder; a second address cannot become one.
      await expect(bootstrapOperator(sql, input())).rejects.toThrow(/already has/);
      const registered = token();
      await ensureServiceToken(sql, registered);
      await ensureServiceToken(sql, registered);
      // A new stored value rotates the same service's token rather than adding a second service.
      expect(await ensureServiceToken(sql, { ...registered, token: generateServiceTokenValue() })).toMatchObject({ outcome: "rotated" });
    });
    expect(await sql`SELECT 1 FROM core.subjects WHERE kind = 'service'`).toHaveLength(1);
  });

  it("does not allow the application role to invoke deployment management", async () => {
    await as("mpc_app", async () => {
      await expect(bootstrapOperator(sql, input())).rejects.toThrow(/migration table owner/);
      await expect(sql`SELECT * FROM core.open_bootstrap_enrolment_window(${randomUUID()})`).rejects.toMatchObject({ code: "42501" });
    });
  });
});
