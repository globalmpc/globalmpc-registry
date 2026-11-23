import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrations, runMigrations } from "../src/migrate.js";
import { withActor } from "../src/session.js";

const url = process.env["DATABASE_URL"];
const dbTest = url ? describe : describe.skip;

dbTest("0137: consolidate roles without widening scope or rewriting history", () => {
  const database = `m0137_${process.pid}_${Date.now()}`;
  const login = `m0137_login_${process.pid}_${Date.now()}`;
  const tenant = randomUUID(), organization = randomUUID();
  const subject = randomUUID(), proposer = randomUUID();
  const steward = randomUUID(), reviewer = randomUUID(), voter = randomUUID(), revoked = randomUUID();
  let admin: postgres.Sql, sql: postgres.Sql, app: postgres.Sql;
  let auditBefore: string;

  beforeAll(async () => {
    admin = postgres(url!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const isolated = new URL(url!); isolated.pathname = database;
    sql = postgres(isolated.toString(), { onnotice: () => {}, max: 1 });
    const migrations = listMigrations(), index = migrations.findIndex(m => m.name === "0137_unified_roles.sql");
    expect(index).toBeGreaterThan(0);
    await runMigrations(sql, migrations.slice(0, index));
    for (const id of [tenant]) await sql`INSERT INTO core.tenants(id,slug,display_name) VALUES(${id},${id},'Synthetic migration fixture')`;
    for (const id of [subject, proposer]) await sql`INSERT INTO core.subjects(id,tenant_id,kind,display_name) VALUES(${id},${tenant},'person','Synthetic holder')`;
    await sql`INSERT INTO core.organizations(id,tenant_id,legal_name,jurisdiction) VALUES(${organization},${tenant},'Synthetic firm','MNG')`;
    for (const [id, role, ended] of [[steward,'data_steward',false],[reviewer,'reviewer_legal',false],[voter,'project_voter',false],[revoked,'reviewer_lab',true]] as const) {
      await sql`INSERT INTO core.role_bindings(id,tenant_id,subject_id,organization_id,role,revoked_at)
        VALUES(${id},${tenant},${subject},${organization},${role},${ended ? sql`now()` : null})`;
    }
    await sql`INSERT INTO core.role_grant_requests(id,tenant_id,subject_id,role,reason,requested_by_subject_id)
      VALUES(${randomUUID()},${tenant},${subject},'reviewer_legal','Synthetic pending grant',${proposer})`;
    await sql`INSERT INTO audit.events(tenant_id,command,resource_type,reason,correlation_id,effective_role,detail)
      VALUES(${tenant},'synthetic.historical','fixture','Retain original meaning','m0137','reviewer_legal','{"signedHash":"unchanged"}')`;
    auditBefore = JSON.stringify(await sql`SELECT to_jsonb(e) - 'tenant_id' AS row FROM audit.events e ORDER BY id`);
    await runMigrations(sql, migrations);
    await sql.unsafe(`CREATE ROLE ${login} LOGIN PASSWORD 'synthetic-local-only' NOSUPERUSER NOBYPASSRLS IN ROLE mpc_app`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA core TO ${login}`);
    isolated.username = login; isolated.password = 'synthetic-local-only';
    app = postgres(isolated.toString(), { onnotice: () => {}, max: 1 });
  });
  afterAll(async () => {
    if (app) await app.end();
    if (sql) await sql.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${login}`);
      await admin.end();
    }
  });

  it("retains original project reach, invalid voting scope and frozen records", async () => {
    const rows = await sql`SELECT id,role,scope_kind,governance_scope,revoked_at FROM core.role_bindings ORDER BY id`;
    expect(rows.find(r => r.id === steward)).toMatchObject({role:'reviewer',scope_kind:'organization',governance_scope:'none'});
    expect(rows.find(r => r.id === reviewer)).toMatchObject({role:'reviewer',scope_kind:'registry',governance_scope:'none'});
    expect(rows.find(r => r.id === voter)).toMatchObject({role:'project_member',scope_kind:'none',governance_scope:'none'});
    expect(rows.find(r => r.id === revoked)?.role).toBe('reviewer_lab');
    expect(JSON.stringify(await sql`SELECT to_jsonb(e) AS row FROM audit.events e WHERE command='synthetic.historical' ORDER BY id`)).toBe(auditBefore);
    expect((await sql`SELECT state,role FROM core.role_grant_requests`)[0]).toMatchObject({state:'withdrawn',role:'reviewer_legal'});
    expect((await sql`SELECT count(*)::int n FROM audit.events WHERE command='authorization.role.consolidated'`)[0]!.n).toBe(3);
  });

  it("keeps runtime RLS and rejects legacy grants and scope edits", async () => {
    const [role] = await app`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual({rolsuper:false,rolbypassrls:false});
    await withActor(app,{subjectId:subject},async tx => {
      expect(await tx`SELECT id FROM core.role_bindings WHERE id=${steward}`).toHaveLength(1);
    });
    await withActor(app,{subjectId:randomUUID()},async tx => {
      expect(await tx`SELECT id FROM core.role_bindings WHERE id=${steward}`).toHaveLength(0);
    });
    expect(await app`SELECT id FROM core.role_bindings WHERE id=${steward}`).toHaveLength(0);
    await expect(sql`INSERT INTO core.role_bindings(id,subject_id,role) VALUES(${randomUUID()},${subject},'data_steward')`).rejects.toThrow('Unknown standing role');
    await expect(sql`UPDATE core.role_bindings SET scope_kind='registry' WHERE id=${steward}`).rejects.toThrow('Role scope cannot be rewritten');
    await expect(sql`INSERT INTO core.role_bindings(id,subject_id,role,scope_kind) VALUES(${randomUUID()},${subject},'project_member','registry')`).rejects.toThrow('Registry-wide project access');
  });
});
