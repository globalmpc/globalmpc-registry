import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { savedProjectProgress } from "../src/services/project-progress.js";
import { setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("saved stage progress in the private project list", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string, otherTenant: string, scoped: string, reader: string;
  const evaluatedAt = "2026-10-01T00:00:00.000Z";
  const stage = { gateId: "stage.exploration", ruleSetVersion: "1", status: "gap", missing: ["permit"], reviewedItems: "1", requiredItems: "2" };
  const summary = { evaluatedAt, currentStage: null, stages: [stage] };
  async function save(projectId: string, snapshot: Record<string, unknown>, createdAt: string, id: string = randomUUID()) {
    await fx.sql`INSERT INTO core.evidence_ledger_snapshots
      (id, tenant_id, project_id, evaluated_at, input_snapshot_hash, snapshot, created_at)
      VALUES (${id}, ${fx.tenantA}, ${projectId}, ${evaluatedAt}, ${"0x" + "a".repeat(64)}, ${fx.sql.json(snapshot as never)}, ${createdAt})`;
  }
  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    otherTenant = await signIn(app, fx.operatorB);
    scoped = await signIn(app, fx.scopedStewardA);
    reader = await signIn(app, fx.readerA);
    await save(fx.projectA, { ...summary, evaluatedAt: "2026-10-05T00:00:00.000Z", currentStage: "old" }, "2026-10-06T00:00:00Z");
    await save(fx.projectA, { ...summary, stages: [{ ...stage, policySetId: randomUUID() }], inputBasis: { secret: true }, items: [{ claimIds: [randomUUID()] }] }, "2026-10-07T00:00:00Z");
  });
  afterAll(async () => { await app.close(); await fx.close(); });
  function list(token?: string) {
    return app.inject({ method: "GET", url: "/api/v1/projects", headers: token ? { authorization: `Bearer ${token}` } : {} });
  }
  it("uses a non-superuser NOBYPASSRLS runtime and returns only the latest saved summary without evaluation", async () => {
    const [role] = await fx.appSql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const before = await fx.sql`SELECT count(*) FROM core.evidence_ledger_snapshots WHERE tenant_id = ${fx.tenantA}`;
    const response = await list(operator);
    expect(response.statusCode).toBe(200);
    expect(response.json().items.find((item: { id: string }) => item.id === fx.projectA).stageProgress).toEqual(summary);
    expect(response.json().items.find((item: { id: string }) => item.id === fx.otherProjectA).stageProgress).toBeNull();
    const after = await fx.sql`SELECT count(*) FROM core.evidence_ledger_snapshots WHERE tenant_id = ${fx.tenantA}`;
    expect(after).toEqual(before);
    // Real endpoint and batch helper both honor tenant context, even for a known foreign ID.
    const foreign = await withTenant(fx.appSql, { tenantId: fx.tenantB }, tx => savedProjectProgress(tx, fx.tenantB, [fx.projectA]));
    expect(foreign.size).toBe(0);
    expect((await list(otherTenant)).json().items.some((item: { id: string }) => item.id === fx.projectA)).toBe(false);
  });
  it("retains project scope and rejects anonymous and wrong-role access", async () => {
    const response = await list(scoped);
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([fx.projectA]);
    expect(response.json().items[0].stageProgress).toEqual(summary);
    expect((await list()).statusCode).toBe(401);
    expect((await list(reader)).statusCode).toBe(403);
  });
  it("does not fall back to an older passing summary when the latest stored value is malformed", async () => {
    await save(fx.otherProjectA, summary, "2026-10-08T00:00:00Z");
    await save(fx.otherProjectA, { ...summary, stages: [{ ...stage, status: "unknown" }] }, "2026-10-09T00:00:00Z");
    const response = await list(operator);
    expect(response.statusCode).toBe(200);
    expect(response.json().items.find((item: { id: string }) => item.id === fx.otherProjectA).stageProgress).toBeNull();
    expect(response.json().items.find((item: { id: string }) => item.id === fx.projectA).stageProgress).toEqual(summary);
  });
  it("matches worker ordering for identical creation times regardless of insert order or evaluated time", async () => {
    const suffix = randomUUID().slice(8);
    const low = "10000000" + suffix;
    const high = "f0000000" + suffix;
    const latest = { ...summary, stages: [{ ...stage, reviewedItems: "0" }] };
    await save(fx.otherProjectA, latest, "2026-10-10T00:00:00Z", high);
    await save(fx.otherProjectA, { ...summary, evaluatedAt: "2026-10-11T00:00:00Z" }, "2026-10-10T00:00:00Z", low);
    const response = await list(operator);
    expect(response.statusCode).toBe(200);
    expect(response.json().items.find((item: { id: string }) => item.id === fx.otherProjectA).stageProgress).toEqual(latest);
    const [workerChoice] = await withTenant(fx.appSql, { tenantId: fx.tenantA }, tx => tx`
      SELECT id FROM core.evidence_ledger_snapshots WHERE tenant_id=${fx.tenantA}
      AND project_id=${fx.otherProjectA} ORDER BY created_at DESC, id DESC LIMIT 1`);
    expect(workerChoice!.id).toBe(high);
    await save(fx.otherProjectA, { ...summary, stages: null }, "2026-10-10T00:00:00Z", "ff000000" + suffix);
    const invalid = await list(operator);
    expect(invalid.json().items.find((item: { id: string }) => item.id === fx.otherProjectA).stageProgress).toBeNull();
  });
  it("handles an empty capped selection without evaluating or fetching anything", async () => {
    const result = await withTenant(fx.appSql, { tenantId: fx.tenantA }, tx => savedProjectProgress(tx, fx.tenantA, []));
    expect(result.size).toBe(0);
  });
});
