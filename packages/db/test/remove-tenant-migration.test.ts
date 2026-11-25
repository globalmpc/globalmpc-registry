import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrations, runMigrations } from "../src/migrate.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

/**
 * 0169 on a populated database.
 *
 * A managed migration owner that owns every object but that row-level security still filters is
 * refused before anything changes: the actor helpers and the role-scope rename need to see every
 * row, as the definer functions it owns already do (0131). The check is by behaviour, not role
 * attribute: an owner with neither superuser nor BYPASSRLS that RLS does not apply to (a managed
 * master role, or tables without FORCE) migrates, and every row survives with its scope renamed.
 */
describeDb("0169: tenant removal on a populated database", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const database = `m0169_${stamp}`;
  const owner = `m0169_owner_${stamp}`;
  const tenant = randomUUID(), org = randomUUID(), person = randomUUID(), project = randomUUID();
  const registryBinding = randomUUID(), revokedBinding = randomUUID(), orgBinding = randomUUID();
  let admin: postgres.Sql, sql: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(url!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const isolated = new URL(url!);
    isolated.pathname = database;
    sql = postgres(isolated.toString(), { onnotice: () => {}, max: 1 });
    const all = listMigrations();
    await runMigrations(sql, all.filter((migration) => migration.name < "0169"));

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, 'registry', 'Synthetic Registry')`;
    await sql`INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction) VALUES (${org}, ${tenant}, 'Synthetic org', 'MNG')`;
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${person}, ${tenant}, 'person', 'Synthetic person')`;
    await sql`INSERT INTO core.projects (id, tenant_id, project_key, name, host_country_iso3, owner_organization_id)
      VALUES (${project}, ${tenant}, 'M0169', 'Synthetic project', 'MNG', ${org})`;
    for (const [id, role, scope, revoked] of [
      [registryBinding, "administrator", "tenant", false],
      [revokedBinding, "reviewer", "tenant", true],
      [orgBinding, "project_member", "organization", false],
    ] as const) {
      await sql`INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role, scope_kind, revoked_at)
        VALUES (${id}, ${tenant}, ${person}, ${org}, ${role}, ${scope}, ${revoked ? sql`now()` : null})`;
    }

    // Hand every object the migration changes to a managed owner, then migrate as that owner.
    await sql.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    for (const schema of ["core", "chain", "audit"]) await sql.unsafe(`ALTER SCHEMA ${schema} OWNER TO ${owner}`);
    const relations = await sql<{ name: string; kind: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name, c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('core', 'chain', 'audit') AND c.relkind IN ('r', 'p', 'v', 'm')`;
    for (const r of relations) await sql.unsafe(`ALTER ${r.kind === "v" ? "VIEW" : r.kind === "m" ? "MATERIALIZED VIEW" : "TABLE"} ${r.name} OWNER TO ${owner}`);
    const functions = await sql<{ signature: string }[]>`
      SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('core', 'chain', 'audit')`;
    for (const f of functions) await sql.unsafe(`ALTER FUNCTION ${f.signature} OWNER TO ${owner}`);
    const types = await sql<{ name: string }[]>`
      SELECT format('%I.%I', n.nspname, t.typname) AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname IN ('core', 'chain', 'audit') AND t.typtype IN ('e', 'd', 'c')
        AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')`;
    for (const t of types) await sql.unsafe(`ALTER TYPE ${t.name} OWNER TO ${owner}`);
    await sql.unsafe(`GRANT mpc_app, mpc_worker TO ${owner} WITH ADMIN OPTION`);
    await sql.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);

  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${owner}`);
      await admin.end();
    }
  });

  it("refuses an owner that row-level security still filters, before changing anything", async () => {
    const [role] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${owner}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await sql.unsafe(`SET ROLE ${owner}`);
    try {
      await expect(runMigrations(sql, listMigrations())).rejects.toThrow(
        /TENANT_REMOVAL_REQUIRES_BYPASSRLS: row-level security still applies to m0169_owner_\S+ \(superuser f, bypassrls f, member of mpc_app, mpc_worker\) on \d+ table\(s\): (audit|chain|core)\./,
      );
    } finally {
      await sql.unsafe("RESET ROLE");
    }
    expect(await sql`SELECT name FROM core.schema_migrations WHERE name >= '0169'`).toHaveLength(0);
    expect(await sql`SELECT scope_kind FROM core.role_bindings WHERE id = ${registryBinding}`).toEqual([{ scope_kind: "tenant" }]);
  }, 120_000);

  it("migrates under an owner without superuser or BYPASSRLS that RLS does not apply to", async () => {
    // What the develop Aurora `postgres` shows: neither attribute, yet its definers read with
    // row_security off. Here the owner is exempt because its tables are not FORCE.
    const forced = await sql<{ name: string }[]>`
      SELECT c.oid::regclass::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('core', 'chain', 'audit') AND c.relkind IN ('r', 'p') AND c.relforcerowsecurity`;
    expect(forced.length).toBeGreaterThan(0);
    for (const t of forced) await sql.unsafe(`ALTER TABLE ${t.name} NO FORCE ROW LEVEL SECURITY`);
    const [role] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${owner}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await sql.unsafe(`SET ROLE ${owner}`);
    try {
      await runMigrations(sql, listMigrations());
    } finally {
      await sql.unsafe("RESET ROLE");
    }
    const rows = await sql<{ id: string; scope_kind: string }[]>`
      SELECT id, scope_kind FROM core.role_bindings WHERE subject_id = ${person} ORDER BY id`;
    expect(Object.fromEntries(rows.map((row) => [row.id, row.scope_kind]))).toEqual({
      [registryBinding]: "registry", [revokedBinding]: "registry", [orgBinding]: "organization",
    });
    expect(await sql`SELECT id FROM core.projects WHERE id = ${project} AND owner_organization_id = ${org}`).toHaveLength(1);
    expect(await sql`SELECT id FROM core.subjects WHERE id = ${person}`).toHaveLength(1);
    expect(await sql`SELECT to_regclass('core.tenants') AS t`).toEqual([{ t: null }]);
  }, 120_000);
});
