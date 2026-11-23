import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listMigrations, runMigrations } from "../src/migrate.js";
import { withActor } from "../src/session.js";

const url = process.env["DATABASE_URL"];
const dbTest = url ? describe : describe.skip;

/**
 * 0168: project reach decided by the actor's live role bindings, under the runtime role.
 *
 * Company A owns A1 (hosted in MNG) and A2 (KOR); company B owns B1 (MNG). Every check runs as a
 * NOSUPERUSER NOBYPASSRLS login in `mpc_app`, the API's runtime grants.
 */
dbTest("0168/0169: actor-based project row-level security", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const database = `m0168_${stamp}`;
  const login = `m0168_login_${stamp}`;
  const orgA = randomUUID(), orgB = randomUUID();
  const a1 = randomUUID(), a2 = randomUUID(), b1 = randomUUID();
  const memberA = randomUUID(), reviewerA1 = randomUUID(), operator = randomUUID();
  const mongoliaReviewer = randomUUID(), revoked = randomUUID(), suspended = randomUUID();
  const unbound = randomUUID(), memberB = randomUUID();
  let admin: postgres.Sql, owner: postgres.Sql, app: postgres.Sql;

  const visibleProjects = (subjectId: string) =>
    withActor(app, { subjectId }, async (tx) =>
      (await tx<{ id: string }[]>`SELECT id FROM core.projects ORDER BY id`).map((row) => row.id));
  const visibleRequirements = (subjectId: string) =>
    withActor(app, { subjectId }, async (tx) =>
      (await tx<{ project_id: string }[]>`SELECT project_id FROM core.document_requirements`)
        .map((row) => row.project_id).sort());
  const addRequirement = (subjectId: string, projectId: string) =>
    withActor(app, { subjectId }, (tx) => tx`
      INSERT INTO core.document_requirements (project_id, document_type, tier, created_by)
      VALUES (${projectId}, ${`Synthetic ${randomUUID().slice(0, 8)}`}, 'required', ${subjectId})`);
  const sorted = (...ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    admin = postgres(url!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const isolated = new URL(url!);
    isolated.pathname = database;
    owner = postgres(isolated.toString(), { onnotice: () => {}, max: 1 });
    await runMigrations(owner, listMigrations());

    for (const [id, name] of [[orgA, "Synthetic A"], [orgB, "Synthetic B"]] as const) {
      await owner`INSERT INTO core.organizations (id, legal_name, jurisdiction) VALUES (${id}, ${name}, 'MNG')`;
    }
    for (const id of [memberA, reviewerA1, operator, mongoliaReviewer, revoked, suspended, unbound, memberB]) {
      await owner`INSERT INTO core.subjects (id, kind, display_name) VALUES (${id}, 'person', 'Synthetic person')`;
    }
    for (const [id, org, host] of [[a1, orgA, "MNG"], [a2, orgA, "KOR"], [b1, orgB, "MNG"]] as const) {
      await owner`INSERT INTO core.projects (id, project_key, name, host_country_iso3, owner_organization_id)
        VALUES (${id}, ${`p-${id.slice(0, 8)}`}, 'Synthetic project', ${host}, ${org})`;
      await owner`INSERT INTO core.document_requirements (project_id, document_type, tier, created_by)
        VALUES (${id}, 'Baseline', 'required', ${operator})`;
    }
    const bind = (subject: string, role: string, scope: string, extra: { org?: string; project?: string; jurisdiction?: string[] } = {}) =>
      owner`INSERT INTO core.role_bindings (id, subject_id, role, scope_kind, organization_id, project_id, jurisdiction)
        VALUES (${randomUUID()}, ${subject}, ${role}, ${scope}, ${extra.org ?? null}, ${extra.project ?? null}, ${extra.jurisdiction ?? null})`;
    await bind(memberA, "project_member", "organization", { org: orgA });
    await bind(memberB, "project_member", "organization", { org: orgB });
    await bind(reviewerA1, "reviewer", "registry", { project: a1 });
    await bind(operator, "administrator", "registry");
    await bind(mongoliaReviewer, "reviewer", "registry", { jurisdiction: ["MNG"] });
    await bind(revoked, "administrator", "registry");
    await owner`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${revoked}`;
    await bind(suspended, "administrator", "registry");
    await owner`UPDATE core.subjects SET suspended_at = now() WHERE id = ${suspended}`;

    await owner.unsafe(`CREATE ROLE ${login} LOGIN PASSWORD 'synthetic-local-only' NOSUPERUSER NOBYPASSRLS IN ROLE mpc_app`);
    isolated.username = login;
    isolated.password = "synthetic-local-only";
    app = postgres(isolated.toString(), { onnotice: () => {}, max: 1 });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.end();
    if (owner) await owner.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${login}`);
      await admin.end();
    }
  });

  it("runs as a runtime login that does not bypass RLS", async () => {
    const [role] = await app`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("limits an organization member to its organization's projects", async () => {
    expect(await visibleProjects(memberA)).toEqual(sorted(a1, a2));
    expect(await visibleRequirements(memberA)).toEqual(sorted(a1, a2));
    await addRequirement(memberA, a2);
    await expect(addRequirement(memberA, b1)).rejects.toThrow(/row-level security/);
    // A direct read of another company's project by id returns nothing, not the row.
    const leaked = await withActor(app, { subjectId: memberA }, (tx) =>
      tx`SELECT id FROM core.document_requirements WHERE project_id = ${b1}`);
    expect(leaked).toHaveLength(0);
  });

  it("limits a project binding to that project, even inside the same organization", async () => {
    expect(await visibleProjects(reviewerA1)).toEqual([a1]);
    expect(await visibleRequirements(reviewerA1)).toEqual([a1]);
    await expect(addRequirement(reviewerA1, a2)).rejects.toThrow(/row-level security/);
  });

  it("lets an organization member create its own organization's project, and no other", async () => {
    const created = randomUUID();
    const [row] = await withActor(app, { subjectId: memberA }, (tx) => tx`
      INSERT INTO core.projects (id, project_key, name, host_country_iso3, owner_organization_id)
      VALUES (${created}, ${`p-${created.slice(0, 8)}`}, 'Synthetic new project', 'MNG', ${orgA})
      RETURNING id`);
    expect(row).toEqual({ id: created });
    await addRequirement(memberA, created);
    expect(await visibleProjects(memberB)).not.toContain(created);

    const foreign = randomUUID();
    await expect(withActor(app, { subjectId: memberA }, (tx) => tx`
      INSERT INTO core.projects (id, project_key, name, host_country_iso3, owner_organization_id)
      VALUES (${foreign}, ${`p-${foreign.slice(0, 8)}`}, 'Synthetic foreign project', 'MNG', ${orgB})`))
      .rejects.toThrow(/row-level security/);
  });

  it("does not let a member move a project out of reach or into another company", async () => {
    await expect(withActor(app, { subjectId: memberA }, (tx) =>
      tx`UPDATE core.projects SET owner_organization_id = ${orgB} WHERE id = ${a2}`))
      .rejects.toThrow(/row-level security|owner/i);
    const touched = await withActor(app, { subjectId: memberA }, (tx) =>
      tx`UPDATE core.projects SET name = 'Synthetic rename' WHERE id = ${b1} RETURNING id`);
    expect(touched).toHaveLength(0);
  });

  it("gives a Registry-wide binding every project and narrows a jurisdiction-limited one", async () => {
    const all = await visibleProjects(operator);
    expect(all).toEqual(expect.arrayContaining([a1, a2, b1]));
    expect(await visibleProjects(mongoliaReviewer)).toEqual(expect.arrayContaining([a1, b1]));
    expect(await visibleProjects(mongoliaReviewer)).not.toContain(a2);
    await expect(addRequirement(mongoliaReviewer, a2)).rejects.toThrow(/row-level security/);
  });

  it("scopes optional-project records by project and child records by their parent", async () => {
    const onB1 = randomUUID(), registryWide = randomUUID();
    await owner`INSERT INTO core.notifications (id, kind, audience_role, project_id, summary, link)
      VALUES (${onB1}, 'readiness_gap', 'reviewer', ${b1}, 'Synthetic B1 gap', '/w')`;
    await owner`INSERT INTO core.notifications (id, kind, audience_role, summary, link)
      VALUES (${registryWide}, 'readiness_gap', 'reviewer', 'Synthetic Registry notice', '/w')`;
    await owner`INSERT INTO core.notification_reads (notification_id, subject_id) VALUES (${onB1}, ${memberB})`;

    const seen = (subjectId: string) => withActor(app, { subjectId }, async (tx) => ({
      notifications: (await tx<{ id: string }[]>`SELECT id FROM core.notifications WHERE id IN (${onB1}, ${registryWide})`).map((r) => r.id).sort(),
      reads: (await tx`SELECT notification_id FROM core.notification_reads WHERE notification_id = ${onB1}`).length,
    }));
    expect(await seen(memberA)).toEqual({ notifications: [registryWide], reads: 0 });
    expect(await seen(memberB)).toEqual({ notifications: sorted(onB1, registryWide), reads: 1 });
    expect(await seen(randomUUID())).toEqual({ notifications: [], reads: 0 });
    // Marking another company's notification read is refused through its parent.
    await expect(withActor(app, { subjectId: memberA }, (tx) =>
      tx`INSERT INTO core.notification_reads (notification_id, subject_id) VALUES (${onB1}, ${memberA})`))
      .rejects.toThrow(/row-level security/);
  });

  it("reaches nothing for revoked, suspended, unbound or absent actors", async () => {
    for (const subjectId of [revoked, suspended, unbound, randomUUID()]) {
      expect(await visibleProjects(subjectId)).toEqual([]);
      expect(await visibleRequirements(subjectId)).toEqual([]);
    }
    expect(await app`SELECT id FROM core.projects`).toHaveLength(0);
  });

  it("answers review independence from all of a person's bindings, not the caller's reach (0170)", async () => {
    // A reviewer of B's project, bound for company B: an affiliation reviewerA1 cannot see.
    const bReviewer = randomUUID();
    await owner`INSERT INTO core.subjects (id, kind, display_name) VALUES (${bReviewer}, 'person', 'Synthetic person')`;
    await owner`INSERT INTO core.role_bindings (id, subject_id, role, scope_kind, organization_id, project_id, granted_at)
      VALUES (${randomUUID()}, ${bReviewer}, 'reviewer', 'registry', ${orgB}, ${b1}, now() - interval '1 day')`;
    await owner`INSERT INTO core.role_bindings (id, subject_id, role, scope_kind, organization_id, project_id, revoked_at)
      VALUES (${randomUUID()}, ${bReviewer}, 'reviewer', 'registry', ${orgA}, ${a1}, now())`;
    const asActor = (subjectId: string) => withActor(app, { subjectId }, async (tx) => ({
      visible: (await tx`SELECT id FROM core.role_bindings WHERE subject_id = ${bReviewer}`).length,
      ...(await tx<{ organizations: string[]; holder: string | null }[]>`
        SELECT core.subject_affiliated_organizations(${bReviewer}) AS organizations,
               core.subject_holder_organization(${bReviewer}) AS holder`)[0]!,
    }));
    // The table shows a decider bound to A1 only the revoked binding on A1, not the live one on B1;
    // the helpers see the live one and ignore the revoked one.
    expect(await asActor(reviewerA1)).toEqual({ visible: 1, organizations: [orgB], holder: orgB });
    // A suspended or unknown actor learns nothing: unknown, which is never independent.
    for (const nobody of [suspended, randomUUID()]) {
      expect(await asActor(nobody)).toEqual({ visible: 0, organizations: [], holder: null });
    }
    const [direct] = await app`SELECT core.subject_affiliated_organizations(${bReviewer}) AS organizations`;
    expect(direct!.organizations).toEqual([]);
  });

  it("does not leak the actor to the next transaction on a pooled connection", async () => {
    expect(await visibleProjects(reviewerA1)).toEqual([a1]);
    const [context] = await app`SELECT core.current_actor() AS actor`;
    expect(context!.actor).toBeNull();
    expect(await app`SELECT id FROM core.projects`).toHaveLength(0);
  });
});
