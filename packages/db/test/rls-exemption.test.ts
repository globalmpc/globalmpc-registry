import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rlsExemptionProblem } from "../src/connecting-role.js";
import { runMigrations } from "../src/migrate.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

/** The operator CLIs' check: RLS must not apply to the connection, decided by behaviour. */
describeDb("rlsExemptionProblem", () => {
  const database = `rls_exempt_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql, sql: postgres.Sql;
  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const isolated = new URL(url!);
    isolated.pathname = database;
    sql = postgres(isolated.toString(), { max: 1, onnotice: () => {} });
    await runMigrations(sql);
  }, 180_000);
  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("accepts a role that bypasses", async () => {
    const [role] = await sql`SELECT rolsuper OR rolbypassrls AS exempt FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ exempt: true });
    expect(await rlsExemptionProblem(sql)).toBeNull();
  });

  it("names the tables for a NOSUPERUSER NOBYPASSRLS role that policies apply to", async () => {
    const [role] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'mpc_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await sql`SET ROLE mpc_app`;
    try {
      expect(await rlsExemptionProblem(sql)).toMatch(/^Row-level security still applies to the connecting role .*row-level security applies on \d+ table\(s\): (audit|chain|core)\./);
    } finally {
      await sql`RESET ROLE`;
    }
    expect((await sql`SELECT current_setting('row_security') AS v`)[0]).toEqual({ v: "on" });
  });
});
