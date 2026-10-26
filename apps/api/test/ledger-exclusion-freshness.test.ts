import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { projectKeyOf, projectProjection, publishProject } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("public freshness warnings respect approved exclusions", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  beforeEach(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });
  afterEach(async () => { await app?.close(); await fx?.close(); });

  it.each([true, false])("keeps old claims quiet when excluded before publication: %s, without hiding unsafe evidence", async (excludedBeforePublication) => {
    const drafter = await signIn(app, fx.operatorA);
    const publisher = await signIn(app, fx.disclosureApproverA);
    const steward = await signIn(app, fx.stewardA);
    const claimType = `excluded_${randomUUID().replaceAll("-", "")}`;
    const catalogId = randomUUID(), proposalId = randomUUID(), claimId = randomUUID();
    const payload = { claimType, displayName: "Excluded historical evidence", description: null, definition: { fields: [] } };
    await fx.sql.begin(async tx => {
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${proposalId},${fx.tenantA},'claim_type',${claimType},1,${tx.json(payload)},'Regression fixture',now(),${fx.operatorSubjectA})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        SELECT ${catalogId},tenant_id,item_key,1,${payload.displayName},payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposalId}`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Regression fixture',materialized_id=${catalogId},version=2 WHERE id=${proposalId}`;
      await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,as_of)
        VALUES(${claimId},${fx.tenantA},${fx.projectA},${claimType},'Historical evidence','{}','unverified',${catalogId},1,'{}','2000-01-01')`;
      if (excludedBeforePublication) await tx`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
        VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},${claimType},1,'not_applicable','Explicitly excluded',${fx.operatorSubjectA})`;
      const definition = {
        ruleSetId: 'exclusion-freshness', version: '1.0.0', effectiveFrom: '2020-01-01T00:00:00Z',
        supersededBy: null, jurisdictionProfile: 'MNG', gateId: 'stage.exploration', retroactive: false,
        requirements: [{ requirementId: 'historical-evidence', label: 'Historical evidence', appliesWhen: { op: 'always' },
          requiredClaimTypes: [claimType], minimumGrade: 'verified', freshnessThresholdDays: '180',
          requiredAttestations: [], blockingConflictTypes: [], notEvaluableWhen: { op: 'never' }, watchWhen: null }],
      };
      await tx`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
        VALUES(${randomUUID()},${fx.tenantA},'exclusion-freshness','1.0.0','stage.exploration','MNG',now(),${tx.json(definition)},'effective')`;
    });
    const assessed = await app.inject({ method: 'POST', url: `/api/v1/projects/${fx.projectA}/evidence-ledger`,
      headers: { authorization: `Bearer ${drafter}`, 'idempotency-key': idempotencyKey() }, payload: {} });
    expect(assessed.statusCode, assessed.body).toBe(200);
    expect(assessed.json().snapshot.items.find((item: { claimType: string }) => item.claimType === claimType).status).toBe(excludedBeforePublication ? 'not_applicable' : 'unreviewed');
    const publication = await publishProject(app, fx.sql, { drafter, publisher }, fx.projectA,
      { projection: await projectProjection(fx.sql, fx.projectA, { evidenceLedger: assessed.json().publicProjection }) });
    expect(publication.statusCode, publication.body).toBe(200);
    const [frozen] = await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    const url = `/api/v1/public/registries/project/${await projectKeyOf(fx.sql, fx.projectA)}`;
    if (!excludedBeforePublication) {
      const unreviewed = await app.inject({ method: 'GET', url });
      expect(unreviewed.statusCode, unreviewed.body).toBe(200);
      expect(unreviewed.json().evidenceLedgerCurrent.warnings).toMatchObject([{ claimType, status: 'needs_re_review' }]);
      const excluded = await app.inject({ method: 'POST', url: `/api/v1/projects/${fx.projectA}/facts/${claimType}/confirmations`,
        headers: { authorization: `Bearer ${steward}`, 'idempotency-key': idempotencyKey(), 'if-match': '"0"' },
        payload: { status: 'not_applicable', reason: 'Exclude positive evidence after publication', factScope: 'catalog' } });
      expect(excluded.statusCode, excluded.body).toBe(200);
      const privateLedger = await app.inject({ method: 'GET', url: `/api/v1/projects/${fx.projectA}/evidence-ledger`,
        headers: { authorization: `Bearer ${steward}` } });
      expect(privateLedger.statusCode, privateLedger.body).toBe(200);
      expect(privateLedger.json().snapshot.items.find((item: { claimType: string }) => item.claimType === claimType).status).toBe('not_applicable');
    }
    const current = await app.inject({ method: 'GET', url });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json().evidenceLedgerCurrent.warnings).toEqual([]);
    await fx.sql`UPDATE core.claims SET stale_since=now(),stale_reason='Actual invalidation after approval' WHERE id=${claimId}`;
    const invalidated = await app.inject({ method: 'GET', url });
    expect(invalidated.json().evidenceLedgerCurrent.warnings).toMatchObject([{ claimType, status: 'needs_re_review' }]);
    const [unchanged] = await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    expect(unchanged).toEqual(frozen);
  });
});
