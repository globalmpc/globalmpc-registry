import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  setupFixture,
  signIn,
  testEnv,
  idempotencyKey,
  type TestFixture,
} from "./helpers/db.js";
import rules from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb("readiness policy options", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;
  const otherProject = randomUUID();
  const active = randomUUID();
  const stage = randomUUID();
  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    const [role] = await fx.appSql<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    token = await signIn(app, fx.operatorA);
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
      VALUES (${otherProject},${fx.tenantB},${otherProject},'Other tenant','MNG',ARRAY['copper'],${fx.orgB})`;
    for (const row of [
      {
        id: active,
        tenant: "A",
        state: "effective",
        when: "2000-01-01",
        gate: "registry_publication",
      },
      {
        id: stage,
        tenant: "A",
        state: "effective",
        when: "2000-01-01",
        gate: "stage.exploration",
      },
      {
        id: randomUUID(),
        tenant: "A",
        state: "draft",
        when: "2000-01-01",
        gate: "registry_publication",
      },
      {
        id: randomUUID(),
        tenant: "A",
        state: "effective",
        when: "2999-01-01",
        gate: "registry_publication",
      },
      {
        id: randomUUID(),
        tenant: "B",
        state: "effective",
        when: "2000-01-01",
        gate: "registry_publication",
      },
      {
        id: randomUUID(),
        tenant: "A",
        state: "effective",
        when: "2000-01-01",
        gate: "registry_publication",
        jurisdiction: "ZAF",
      },
    ]) {
      await fx.sql`INSERT INTO core.compliance_policy_sets
        (id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
        VALUES (${row.id},${row.tenant === "A" ? fx.tenantA : fx.tenantB},${row.id},'1.0.0',${row.gate},${"jurisdiction" in row ? row.jurisdiction : "MNG"},${row.when}::timestamptz,${fx.sql.json(rules as never)},${row.state})`;
    }
  });
  afterAll(async () => {
    await app.close();
    await fx.close();
  });
  const options = (
    project: string,
    query = "",
    bearer: string | null = token,
  ) =>
    app.inject({
      method: "GET",
      url: `/api/v1/projects/${project}/readiness-policy-options${query}`,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
  it("lists actual effective tenant policy IDs and uses the returned ID to recompute", async () => {
    const result = await options(fx.projectA);
    expect(result.statusCode, result.body).toBe(200);
    expect(
      result
        .json()
        .items.map((item: { id: string }) => item.id)
        .sort(),
    ).toEqual([active, stage].sort());
    const demoRun = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/readiness-assessments`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { policySetId: "dddddddd-0000-0000-0000-000000000001" },
    });
    expect(demoRun.statusCode).toBe(404);
    expect(demoRun.json().message).toBe("Policy set not found");
    const run = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/readiness-assessments`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { policySetId: active },
    });
    expect(run.statusCode, run.body).toBe(200);
  });
  it("filters a decision gate and returns an empty list for an unconfigured gate", async () => {
    expect(
      (await options(fx.projectA, "?gateId=registry_publication"))
        .json()
        .items.map((item: { id: string }) => item.id),
    ).toEqual([active]);
    expect(
      (await options(fx.projectA, "?gateId=unconfigured")).json().items,
    ).toEqual([]);
  });
  it("refuses anonymous and wrong-role callers", async () => {
    expect((await options(fx.projectA, "", null)).statusCode).toBe(401);
    const scoped = await signIn(app, fx.scopedStewardA);
    expect((await options(fx.otherProjectA, "", scoped)).statusCode).toBe(403);
    const reviewer = await signIn(app, fx.reviewerA);
    expect((await options(fx.projectA, "", reviewer)).statusCode).toBe(403);
  });
  it("does not reveal policies for a missing, malformed or other-tenant project", async () => {
    for (const project of [randomUUID(), "not-an-id", otherProject]) {
      const result = await options(project);
      expect(result.statusCode, result.body).toBe(
        project === "not-an-id" ? 400 : 404,
      );
      expect(result.json().items).toBeUndefined();
    }
  });
});
