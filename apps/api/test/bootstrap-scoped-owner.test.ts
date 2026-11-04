import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@mpc/db";
import { bootstrapOperator } from "../src/bootstrap.js";
import { ensureServiceToken, generateServiceTokenValue } from "../src/service-tokens.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("deployment under FORCE RLS without BYPASSRLS", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const db = `bs_scope_${suffix}`;
  const owner = `bs_owner_${suffix}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const input = (slug = randomUUID(), email = `${randomUUID()}@example.com`) => ({
    tenantSlug: slug, tenantName: slug, organizationName: "Operator", jurisdiction: "MNG",
    subjectName: "Operator", email, role: "mpc_operator", assuranceLevel: "high_assurance" as const,
  });
  beforeAll(async () => {
    admin = postgres(process.env["DATABASE_URL"]!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${db}`);
    await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    const url = new URL(process.env["DATABASE_URL"]!); url.pathname = `/${db}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await runMigrations(sql);
    // Model a managed migration owner, including functions it created. No runtime grants change.
    const tables = await sql`SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('core','chain','audit') AND c.relkind IN ('r','p','S','v','m')`;
    await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA core, chain, audit TO ${owner}`);
    for (const t of tables) {
      // Owned sequences move with their parent table; ordinary tables are enough here.
      const [kind] = await sql`SELECT relkind FROM pg_class WHERE oid=${`${t.nspname}.${t.relname}`}::regclass`;
      if (kind!.relkind === 'r' || kind!.relkind === 'p') await sql.unsafe(`ALTER TABLE "${t.nspname}"."${t.relname}" OWNER TO ${owner}`);
    }
    const funcs = await sql`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('core','chain','audit')`;
    for (const f of funcs) await sql.unsafe(`ALTER FUNCTION ${f.signature} OWNER TO ${owner}`);
    await sql.unsafe(`SET ROLE ${owner}`);
  }, 120_000);
  afterAll(async () => {
    await sql?.end();
    if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`); await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`); await admin.end(); }
  });
  it("creates and reruns an operator without broad row visibility; rejects cross-tenant email atomically", async () => {
    const args = input();
    const first = await bootstrapOperator(sql, args);
    expect(first.created).toBe(true);
    expect(await sql`SELECT 1 FROM core.subjects`).toHaveLength(0);
    expect(await bootstrapOperator(sql, args)).toMatchObject({ subjectId: first.subjectId, created: false });
    const other = input(randomUUID(), args.email);
    await expect(bootstrapOperator(sql, other)).rejects.toThrow(/another.*tenant/);
    expect(await sql`SELECT 1 FROM core.tenants WHERE slug=${other.tenantSlug}`).toHaveLength(0);
    await expect(sql.begin(async tx => {
      await tx`SELECT set_config('app.current_tenant', ${randomUUID()}, true)`;
      return tx`SELECT * FROM core.open_bootstrap_enrolment_window(${first.subjectId})`;
    })).rejects.toMatchObject({code: "P0002"});
  });
  it("opens an expired first-enrolment window and preserves suspension under the scoped owner", async () => {
    const args = input();
    const first = await bootstrapOperator(sql, args);
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.current_tenant', ${first.tenantId}, true)`;
      await tx`UPDATE core.subjects SET created_at = now() - interval '2 days' WHERE id = ${first.subjectId}`;
    });
    expect(await bootstrapOperator(sql, args)).toMatchObject({ enrolmentWindowOpened: true, roleGranted: false });
    await sql.begin(async tx => {
      await tx`SELECT set_config('app.current_tenant', ${first.tenantId}, true)`;
      await tx`UPDATE core.subjects SET suspended_at = now() WHERE id = ${first.subjectId}`;
    });
    await expect(bootstrapOperator(sql, args)).rejects.toThrow(/suspended/);
  });
  it("registers and reruns a service token; rejects hidden cross-tenant collisions", async () => {
    const a = await bootstrapOperator(sql, input());
    const b = await bootstrapOperator(sql, input());
    const token = generateServiceTokenValue();
    const args = { tenantId: a.tenantId, label: "scan-worker", role: "scan_service", scopes: ["scan_result"], token, ttlSeconds: 3600, overlapSeconds: 0 };
    await ensureServiceToken(sql, args);
    await ensureServiceToken(sql, args);
    expect(await sql`SELECT 1 FROM core.service_tokens`).toHaveLength(0);
    await expect(ensureServiceToken(sql, { ...args, tenantId: b.tenantId })).rejects.toThrow(/another service/);
  });
  it("does not allow the application role to invoke deployment management", async () => {
    await sql`RESET ROLE`;
    await sql`SET ROLE mpc_app`;
    try {
      await expect(bootstrapOperator(sql, input())).rejects.toThrow(/migration table owner/);
      await expect(sql`SELECT * FROM core.open_bootstrap_enrolment_window(${randomUUID()})`).rejects.toMatchObject({ code: "42501" });
    }
    finally { await sql.unsafe(`SET ROLE ${owner}`); }
  });
});
