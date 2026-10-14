import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * `jurisdiction[]` ABAC condition — 02 §2.5.
 *
 * The fixture's projects are hosted in MNG. A KAZ project is added here so that a scoped binding
 * has something inside and something outside its jurisdiction in the same tenant.
 */
describeDb("jurisdiction-scoped role bindings", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let kazProject: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    await app.ready();

    kazProject = randomUUID();
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${kazProject}, ${fx.tenantA}, ${`KAZ-${kazProject.slice(0, 8)}`}, 'KAZ Project',
        'KAZ', ARRAY['copper'], ${fx.orgA}
      )
    `;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  /** A tenant-wide reviewer whose binding carries `jurisdiction` (null = unscoped). */
  async function reviewer(jurisdiction: string[] | null): Promise<{ token: string; subjectId: string }> {
    const account = newAccount();
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', 'Scoped reviewer')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${account.address}, 31337, 'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role, jurisdiction)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, 'reviewer_legal', ${jurisdiction})
    `;
    return { token: await signIn(app, account), subjectId };
  }

  function getProject(token: string, projectId: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("allows a scoped binding on a project hosted in its jurisdiction", async () => {
    const { token } = await reviewer(["MNG"]);
    expect((await getProject(token, fx.projectA)).statusCode).toBe(200);
  });

  it("denies a scoped binding on a project hosted elsewhere, and says why", async () => {
    const { token } = await reviewer(["MNG"]);
    const response = await getProject(token, kazProject);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.reason).toBe("JURISDICTION_SCOPE_MISMATCH");
  });

  it("lists only projects inside the binding's jurisdiction", async () => {
    const { token } = await reviewer(["KAZ"]);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const ids = (response.json().items as { id: string }[]).map((item) => item.id);
    expect(ids).toEqual([kazProject]);
  });

  it("leaves an unscoped binding reaching every project, as before", async () => {
    const { token } = await reviewer(null);
    expect((await getProject(token, fx.projectA)).statusCode).toBe(200);
    expect((await getProject(token, kazProject)).statusCode).toBe(200);
  });

  it("does not let a scope be widened in place", async () => {
    const { subjectId } = await reviewer(["MNG"]);
    await expect(
      fx.sql`
        UPDATE core.role_bindings SET jurisdiction = ARRAY['MNG','KAZ']
        WHERE subject_id = ${subjectId}
      `,
    ).rejects.toThrow(/jurisdiction scope cannot be rewritten/);
  });

  it("carries a granted scope from proposal to binding", async () => {
    const { subjectId } = await reviewer(null);
    const operatorToken = await signIn(app, fx.operatorA);

    // The two-person rule needs a second admin holder to approve.
    const approver = newAccount();
    const approverSubject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${approverSubject}, ${fx.tenantA}, 'person', 'Security approver')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${approverSubject}, ${approver.address}, 31337,
        'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${approverSubject}, ${fx.orgA}, 'security_operator')
    `;
    const approverToken = await signIn(app, approver);

    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/role-grants",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        subjectId,
        role: "reviewer_lab",
        organizationId: fx.orgA,
        jurisdiction: ["MNG"],
        reason: "Lab reviewer for Mongolian projects",
      },
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().jurisdiction).toEqual(["MNG"]);

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/admin/role-grants/${proposed.json().id}/decision`,
      headers: {
        authorization: `Bearer ${approverToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${proposed.json().version}"`,
      },
      payload: { decision: "approve", reason: "ok" },
    });
    expect(decided.statusCode).toBe(200);

    const [binding] = await fx.sql<{ jurisdiction: string[] | null }[]>`
      SELECT jurisdiction FROM core.role_bindings
      WHERE subject_id = ${subjectId} AND role = 'reviewer_lab'
    `;
    expect(binding?.jurisdiction).toEqual(["MNG"]);
  });

  it("refuses a jurisdiction that is not an ISO alpha-3 code", async () => {
    const operatorToken = await signIn(app, fx.operatorA);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/role-grants",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        subjectId: randomUUID(),
        role: "reviewer_lab",
        jurisdiction: ["Mongolia"],
        reason: "x",
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
