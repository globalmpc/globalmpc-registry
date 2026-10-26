import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PROJECT_FACT_KEYS } from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
const definition = { fields: [{ key: "note", label: "Note", type: "string", required: false }] };
const base = "/api/v1/review-registry/claim-types/proposals";

describeDb("catalog keys cannot impersonate the legacy matrix", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let reviewer: string;
  let steward: string;
  const catalogId = randomUUID();
  const pendingId = randomUUID();
  const historicalClaimId = randomUUID();

  beforeAll(async () => {
    fx = await setupFixture();
    await fx.sql`INSERT INTO core.role_bindings(id,tenant_id,subject_id,organization_id,role)
      VALUES(${randomUUID()},${fx.tenantA},${fx.reviewerSubjectA},${fx.reviewOrgA},'reviewer_assurance')`;
    // Simulate rows approved/pending before the additive guard migration. Disable only the
    // new guards under transaction locks; all approval, immutability and tenant rules stay on.
    await fx.sql.begin(async (tx) => {
      await tx.unsafe("ALTER TABLE core.registry_proposals DISABLE TRIGGER catalog_proposal_reserved_key_guard");
      await tx.unsafe("ALTER TABLE core.claim_types DISABLE TRIGGER catalog_type_reserved_key_guard");
      await tx.unsafe("ALTER TABLE core.claims DISABLE TRIGGER catalog_claim_reserved_key_guard");
      const approvedId = randomUUID();
      for (const [id, key] of [[approvedId, "rights"], [pendingId, "consent"]] as const) {
        const payload = { claimType: key, displayName: "Historical definition", description: null, definition };
        await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
          VALUES(${id},${fx.tenantA},'claim_type',${key},1,${tx.json(payload)},'Historical proposal',now(),${fx.operatorSubjectA})`;
      }
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        SELECT ${catalogId},tenant_id,item_key,1,'Historical definition',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${approvedId}`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Historical approval',materialized_id=${catalogId},version=2 WHERE id=${approvedId}`;
      await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,catalog_entry_id,catalog_version,structured_values)
        VALUES(${historicalClaimId},${fx.tenantA},${fx.projectA},'rights','Historical claim','{}',${catalogId},1,'{}')`;
      await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
      await tx.unsafe("ALTER TABLE core.registry_proposals ENABLE TRIGGER catalog_proposal_reserved_key_guard");
      await tx.unsafe("ALTER TABLE core.claim_types ENABLE TRIGGER catalog_type_reserved_key_guard");
      await tx.unsafe("ALTER TABLE core.claims ENABLE TRIGGER catalog_claim_reserved_key_guard");
    });
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    reviewer = await signIn(app, fx.reviewerA);
    steward = await signIn(app, fx.stewardA);
  });
  afterAll(async () => { await app?.close(); await fx?.close(); });

  it.each(PROJECT_FACT_KEYS)("rejects reserved proposal %s through API and direct DB", async (key) => {
    const payload = { claimType: key, displayName: "Collision", definition, effectiveFrom: "2026-01-01T00:00:00Z", rationale: "Test collision" };
    const response = await app.inject({ method: "POST", url: base,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() }, payload });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().code).toBe("CLAIM_TYPE_RESERVED");
    await expect(withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
      INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
      VALUES(${randomUUID()},${fx.tenantA},'claim_type',${key},2,${tx.json({ claimType: key, displayName: "Collision", description: null, definition })},'Bypass',now(),${fx.operatorSubjectA})`
    )).rejects.toThrow(/reserved/);
  });

  it("rejects approval of old reserved proposals without rewriting history", async () => {
    const response = await app.inject({ method: "POST", url: `${base}/${pendingId}/decision`,
      headers: { authorization: `Bearer ${reviewer}`, "idempotency-key": idempotencyKey(), "if-match": '"1"' },
      payload: { decision: "approve", reason: "Must not share matrix keys" } });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().code).toBe("CLAIM_TYPE_RESERVED");
    const [pending] = await fx.sql`SELECT state,version FROM core.registry_proposals WHERE id=${pendingId}`;
    expect(pending).toMatchObject({ state: "pending", version: 1 });
    await expect(withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
      UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Bypass',materialized_id=${catalogId},version=2 WHERE id=${pendingId}`
    )).rejects.toThrow(/reserved/);
    const rejected = await app.inject({ method: "POST", url: `${base}/${pendingId}/decision`,
      headers: { authorization: `Bearer ${reviewer}`, "idempotency-key": idempotencyKey(), "if-match": '"1"' },
      payload: { decision: "reject", reason: "Replace this reserved key with a distinct catalog key" } });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().state).toBe("rejected");
    const [historical] = await fx.sql`SELECT claim_type,catalog_version FROM core.claim_types WHERE id=${catalogId}`;
    expect(historical).toMatchObject({ claim_type: "rights", catalog_version: 1 });
  });

  it("hides colliding definitions from selection and rejects ambiguous confirmation writes", async () => {
    const headers = { authorization: `Bearer ${steward}` };
    const catalog = await app.inject({ method: "GET", url: "/api/v1/claim-types", headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().items.some((row: { claimType: string }) => row.claimType === "rights")).toBe(false);
    const facts = await app.inject({ method: "GET", url: `/api/v1/projects/${fx.projectA}/facts`, headers });
    expect(facts.statusCode, facts.body).toBe(200);
    expect(facts.json().items.filter((row: { factKey: string }) => row.factKey === "rights")).toHaveLength(1);
    const ledger = await app.inject({ method: "GET", url: `/api/v1/projects/${fx.projectA}/evidence-ledger`, headers });
    expect(ledger.statusCode, ledger.body).toBe(200);
    expect(ledger.json().snapshot.items.some((row: { claimType: string }) => row.claimType === "rights")).toBe(false);
    expect(ledger.json().snapshot.inputBasis.claims.some((row: { id: string }) => row.id === historicalClaimId)).toBe(false);
    const [historicalClaim] = await fx.sql`SELECT value_text,catalog_entry_id FROM core.claims WHERE id=${historicalClaimId}`;
    expect(historicalClaim).toMatchObject({ value_text: "Historical claim", catalog_entry_id: catalogId });
    const before = await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${fx.projectA}`;
    const response = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/rights/confirmations`,
      headers: { ...headers, "idempotency-key": idempotencyKey(), "if-match": '"0"' },
      payload: { status: "not_applicable", reason: "Catalog applicability must not become a legacy fact" } });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().code).toBe("FACT_KEY_CATALOG_COLLISION");
    expect(await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${fx.projectA}`).toEqual(before);
    expect(await fx.sql`SELECT id FROM core.project_fact_versions WHERE project_id=${fx.projectA} AND fact_key='rights'`).toHaveLength(0);
    const legacy = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/spv/confirmations`,
      headers: { ...headers, "idempotency-key": idempotencyKey(), "if-match": '"0"' },
      payload: { status: "pending", reason: "Unambiguous legacy confirmation still works" } });
    expect(legacy.statusCode, legacy.body).toBe(200);
    const explicitCatalog = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/rights/confirmations`,
      headers: { ...headers, "idempotency-key": idempotencyKey(), "if-match": '"0"' },
      payload: { factScope: "catalog", status: "not_applicable", reason: "Catalog must never modify this row" } });
    expect(explicitCatalog.statusCode, explicitCatalog.body).toBe(422);
    expect(explicitCatalog.json().code).toBe("CLAIM_TYPE_RESERVED");
    const explicitLegacy = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/rights/confirmations`,
      headers: { ...headers, "idempotency-key": idempotencyKey(), "if-match": '"0"' },
      payload: { factScope: "legacy", status: "pending", reason: "Explicit legacy confirmation remains usable" } });
    expect(explicitLegacy.statusCode, explicitLegacy.body).toBe(200);
    expect(explicitLegacy.json()).toMatchObject({ factKey: "rights", status: "pending", version: 1 });
    expect(await fx.sql`SELECT status FROM core.project_facts WHERE project_id=${fx.projectA} AND fact_key='rights'`)
      .toEqual([{ status: "pending" }]);
    const wrongScope = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/distinct_catalog_key/confirmations`,
      headers: { ...headers, "idempotency-key": idempotencyKey(), "if-match": '"0"' },
      payload: { factScope: "legacy", status: "pending", reason: "A catalog key cannot become a legacy fact" } });
    expect(wrongScope.statusCode, wrongScope.body).toBe(422);
    expect(wrongScope.json().code).toBe("FACT_SCOPE_INVALID");
  });

  it("blocks using an old reserved definition for new claims through the API and DB", async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
      payload: { claimType: "rights", catalogEntryId: catalogId, structuredValues: {}, valueText: "Historical collision", sourceCoordinate: {} } });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().code).toBe("CLAIM_TYPE_RESERVED");
    await expect(withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
      INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,catalog_entry_id,catalog_version,structured_values)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},'rights','Bypass','{}',${catalogId},1,'{}')`
    )).rejects.toThrow(/reserved/);
    await expect(withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
      INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
      VALUES(${randomUUID()},${fx.tenantA},'consent',1,'Bypass',${tx.json(definition)},now())`
    )).rejects.toThrow(/reserved/);
  });
});
