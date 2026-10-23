import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("authorized catalog manual confirmations", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let steward: string;
  let operator: string;
  let other: string;
  let scoped: string;
  let claimType: string;
  let futureType: string;
  let otherType: string;

  async function catalog(tenantId: string, subjectId: string, approverId: string, future = false, key = `confirmation_${randomUUID().replaceAll("-", "")}`) {
    const proposal = randomUUID(), id = randomUUID();
    const payload = { claimType: key, displayName: "Synthetic confirmation", description: null, definition: { fields: [] } };
    await fx.sql.begin(async (tx) => {
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${proposal},${tenantId},'claim_type',${key},1,${tx.json(payload)},'Synthetic test',now() + ${future ? "1 day" : "-1 day"}::interval,${subjectId})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        SELECT ${id},tenant_id,item_key,1,'Synthetic confirmation',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposal}`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${approverId},decided_at=now(),decision_reason='Synthetic only',materialized_id=${id},version=2 WHERE id=${proposal}`;
    });
    return key;
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    steward = await signIn(app, fx.stewardA);
    operator = await signIn(app, fx.operatorA);
    other = await signIn(app, fx.operatorB);
    scoped = await signIn(app, fx.scopedStewardA);
    claimType = await catalog(fx.tenantA, fx.operatorSubjectA, fx.reviewerSubjectA);
    futureType = await catalog(fx.tenantA, fx.operatorSubjectA, fx.reviewerSubjectA, true);
    const [subjectB] = await fx.sql<{ id: string }[]>`SELECT id FROM core.subjects WHERE tenant_id=${fx.tenantB} LIMIT 1`;
    const approverB = randomUUID();
    await fx.sql`INSERT INTO core.subjects(id,tenant_id,kind,display_name) VALUES(${approverB},${fx.tenantB},'person','Synthetic B approver')`;
    otherType = await catalog(fx.tenantB, subjectB!.id, approverB);
  });
  afterAll(async () => { await app.close(); await fx.close(); });

  const record = (key: string, status = "pending", version = 0, token = steward, projectId?: string, keyId = idempotencyKey()) => app.inject({
    method: "POST", url: `/api/v1/projects/${projectId ?? fx.projectA}/facts/${key}/confirmations`,
    headers: { authorization: `Bearer ${token}`, "idempotency-key": keyId, "if-match": `"${version}"` },
    payload: { status, reason: "Explicit synthetic applicability decision" },
  });

  it("allows a steward to append and withdraw catalog N/A with immutable audited history", async () => {
    const before = await fx.sql`SELECT fact_key,status,version FROM core.project_facts WHERE project_id=${fx.projectA} ORDER BY fact_key`;
    const requestKey = idempotencyKey();
    const first = await record(claimType, "not_applicable", 0, steward, undefined, requestKey);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ factKey: claimType, status: "not_applicable", version: 1, recorded: true });
    expect(first.headers.etag).toBe('"1"');
    const retry = await record(claimType, "not_applicable", 0, steward, undefined, requestKey);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(first.json());
    const withdrawn = await record(claimType, "pending", 1);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json().history.map((v: { status: string }) => v.status)).toEqual(["pending", "not_applicable"]);
    expect((await record(claimType, "not_applicable", 1)).statusCode).toBe(412);
    const [audit] = await fx.sql`SELECT count(*)::int n FROM audit.events WHERE project_id=${fx.projectA} AND command='project.fact.recorded' AND detail->>'factKey'=${claimType}`;
    expect(audit!.n).toBe(2);
    await expect(fx.sql`UPDATE core.project_fact_versions SET status='rejected' WHERE project_id=${fx.projectA} AND fact_key=${claimType}`).rejects.toThrow(/append-only/);
    const fixedAfter = await fx.sql`SELECT fact_key,status,version FROM core.project_facts WHERE project_id=${fx.projectA} ORDER BY fact_key`;
    expect(fixedAfter).toEqual(before);
    const list = await app.inject({ method: "GET", url: `/api/v1/projects/${fx.projectA}/facts`, headers: { authorization: `Bearer ${steward}` } });
    expect(list.json().items.find((row: { factKey: string }) => row.factKey === claimType)).toMatchObject({ status: "pending", version: 2 });
  });

  it("never overwrites a legacy gate fact even when the catalog uses its key", async () => {
    const gateKey = "issuer_identified";
    await catalog(fx.tenantA, fx.operatorSubjectA, fx.reviewerSubjectA, false, gateKey);
    await fx.sql`INSERT INTO core.project_facts(id,tenant_id,project_id,fact_key,status)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},${gateKey},'pending')`;
    const before = await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${fx.projectA} AND fact_key=${gateKey}`;
    const response = await record(gateKey, "not_applicable");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ factKey: gateKey, status: "not_applicable", version: 1 });
    expect(await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${fx.projectA} AND fact_key=${gateKey}`).toEqual(before);
    const withdrawal = await record(gateKey, "pending", 1);
    expect(withdrawal.statusCode, withdrawal.body).toBe(200);
    expect(withdrawal.json().history).toHaveLength(2);
    expect(await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${fx.projectA} AND fact_key=${gateKey}`).toEqual(before);
  });

  it("rejects unknown, future-effective and other-tenant catalog keys without writing", async () => {
    for (const key of ["not_a_catalog_key", futureType, otherType]) {
      const response = await record(key);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().code).toBe("FACT_KEY_UNKNOWN");
    }
    const rows = await fx.sql`SELECT fact_key FROM core.project_fact_versions WHERE project_id=${fx.projectA} AND fact_key=ANY(${[futureType, otherType, "not_a_catalog_key"]}::text[])`;
    expect(rows).toHaveLength(0);
  });

  it("retains role, project scope, tenant and evidence authorization", async () => {
    expect((await record(claimType, "pending", 0, operator)).statusCode).toBe(403);
    expect([403, 404]).toContain((await record(claimType, "pending", 0, other)).statusCode);
    expect([403, 404]).toContain((await record(claimType, "pending", 0, scoped, fx.otherProjectA)).statusCode);
    expect([403, 404]).toContain((await record(claimType, "pending", 0, steward, randomUUID())).statusCode);
    expect((await record(claimType, "confirmed", 2)).statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/${claimType}/confirmations`,
      headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey(), "if-match": '"2"' },
      payload: { status: "confirmed", reason: "Wrong project", evidence: { kind: "upload", id: randomUUID() } } });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().code).toBe("EVIDENCE_NOT_IN_PROJECT");
  });
});
