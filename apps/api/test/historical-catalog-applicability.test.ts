import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashProjection } from "@mpc/canonical";
import { computeEvidenceLedger, ledgerInputHash, persistEvidenceLedger, publicLedgerProjection, type LedgerSnapshot } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { projectProjection } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
const claimType = "rights";

describeDb("historical catalog warnings do not read legacy matrix applicability", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  beforeEach(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });
  afterEach(async () => { await app?.close(); await fx?.close(); });

  async function historicalPublication(options: { evidence?: boolean; reviewed?: boolean; old?: boolean; passingStage?: boolean; frozenExcluded?: boolean; addedUnreviewed?: boolean; initialGrade?: "verified" | "self_reported"; catalogKey?: string; freshnessDays?: string } = {}) {
    const claimType = options.catalogKey ?? "rights";
    const { evidence = true, reviewed = true, old = false, passingStage = false, frozenExcluded = false, addedUnreviewed = false, initialGrade = "verified" } = options;
    const catalogId = randomUUID(), proposalId = randomUUID(), claimId = randomUUID(), policyId = randomUUID();
    const uploadId = randomUUID(), artifactId = randomUUID(), attestationId = randomUUID();
    const definition = {
      ruleSetId: "historical-rights", version: "1.0.0", effectiveFrom: "2020-01-01T00:00:00Z", supersededBy: null,
      jurisdictionProfile: "MNG", gateId: "stage.exploration", retroactive: false,
      requirements: [{ requirementId: "rights-review", label: "Rights evidence", appliesWhen: { op: "always" },
        requiredClaimTypes: [claimType], minimumGrade: "verified", freshnessThresholdDays: options.freshnessDays ?? (old ? "180" : null),
        requiredAttestations: [], blockingConflictTypes: [], notEvaluableWhen: { op: "never" }, watchWhen: null }],
    };
    const payload = { claimType, displayName: "Historical catalog rights", description: null, definition: { fields: [] } };
    const evaluatedAt = new Date().toISOString();
    let versionId = "";
    // Model a publication made before reserved catalog keys were prohibited. Only the
    // three new-key guards are suspended while importing this isolated historical fixture;
    // restore them before any API request. Published/snapshot immutability stays enabled.
    await fx.sql.begin(async tx => {
      await tx`ALTER TABLE core.registry_proposals DISABLE TRIGGER catalog_proposal_reserved_key_guard`;
      await tx`ALTER TABLE core.claim_types DISABLE TRIGGER catalog_type_reserved_key_guard`;
      await tx`ALTER TABLE core.claims DISABLE TRIGGER catalog_claim_reserved_key_guard`;
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${proposalId},${fx.tenantA},'claim_type',${claimType},1,${tx.json(payload)},'Historical import',now(),${fx.operatorSubjectA})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        SELECT ${catalogId},tenant_id,item_key,1,${payload.displayName},payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposalId}`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Historical import',materialized_id=${catalogId},version=2 WHERE id=${proposalId}`;
      if (evidence) {
        await tx`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
          VALUES(${artifactId},${fx.tenantA},${fx.projectA},'raw_source',${"0x"+"ab".repeat(32)},'restricted')`;
        await tx`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,promoted_artifact_id)
          VALUES(${uploadId},${fx.tenantA},${fx.projectA},${uploadId},${"0x"+"ab".repeat(32)},123,'application/pdf','restricted','promoted',${artifactId})`;
      }
      await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of)
        VALUES(${claimId},${fx.tenantA},${fx.projectA},${claimType},'Historical rights','{}',${initialGrade},${catalogId},1,'{}',${evidence ? [uploadId] : []}::uuid[],${old ? '2000-01-01' : evaluatedAt.slice(0,10)})`;
      if (reviewed) {
        const caseId = randomUUID(), assignmentId = randomUUID();
        await tx`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state)
          VALUES(${caseId},${fx.tenantA},${fx.projectA},${fx.schemaA},'signed')`;
        await tx`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id)
          VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA})`;
        await tx`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
          evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
          VALUES(${attestationId},${fx.tenantA},${caseId},${assignmentId},${fx.credentialA},${fx.schemaA},'professional_signoff',${[claimId]}::uuid[],
          ${"0x"+"ab".repeat(32)},'Historical rights only','{"status":"valid"}','1','1',${"0x"+"ab".repeat(32)},${"0x"+"12".repeat(65)},${fx.reviewerA.address},now(),'signed')`;
      }
      await tx`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
        VALUES(${policyId},${fx.tenantA},'historical-rights','1.0.0','stage.exploration','MNG',now(),${tx.json(definition)},'effective')`;
      const inputBasis = { policies: [{ id: policyId, definition }],
        applicableStageRequirements: [{ policySetId: policyId, requirementId: "rights-review" }],
        manual: frozenExcluded ? [{ fact_key: claimType, status: "not_applicable" }] : [] };
      const status = frozenExcluded ? "not_applicable" : reviewed && evidence ? "reviewed" : "unreviewed";
      const snapshot: LedgerSnapshot = {
        id: null, projectId: fx.projectA, evaluatedAt, inputSnapshotHash: ledgerInputHash(inputBasis, evaluatedAt),
        evaluatorVersion: "1", inputBasis,
        items: [{ claimType, catalogVersion: 1, displayName: payload.displayName, status, grade: initialGrade,
          reviewScope: reviewed ? [claimType] : [], reviews: [], claimIds: [claimId], attestationIds: reviewed ? [attestationId] : [],
          reasons: [frozenExcluded ? "RECORDED_NOT_APPLICABLE" : reviewed && evidence ? "CURRENT_SCOPED_REVIEW" : "CURRENT_SCOPED_REVIEW_REQUIRED"], limitations: [] }],
        stages: [{ gateId: "stage.exploration", policySetId: policyId, ruleSetVersion: "1.0.0", status: passingStage ? "ok" : "gap",
          missing: [], reviewedItems: passingStage ? "1" : "0", requiredItems: "1" }],
        currentStage: passingStage ? "stage.exploration" : null, limitations: [],
      };
      const stored = await persistEvidenceLedger(tx, fx.tenantA, snapshot);
      if (addedUnreviewed) await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of)
        SELECT ${randomUUID()},tenant_id,project_id,claim_type,'Later historical claim',source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of
        FROM core.claims WHERE id=${claimId}`;
      const projection = await projectProjection(fx.sql, fx.projectA, { evidenceLedger: publicLedgerProjection(stored) });
      const entryId = randomUUID();
      versionId = randomUUID();
      await tx`INSERT INTO core.registry_entries(id,tenant_id,registry_type,subject_id,public_key)
        SELECT ${entryId},${fx.tenantA},'project',id,project_key FROM core.projects WHERE id=${fx.projectA}`;
      await tx`INSERT INTO core.registry_entry_versions(id,tenant_id,entry_id,version,status,public_projection,content_hash,source_snapshot_hash,policy_version,schema_version,published_at)
        VALUES(${versionId},${fx.tenantA},${entryId},1,'published',${tx.json(projection as never)},${hashProjection(projection as never)},${stored.inputSnapshotHash},'1','1',now())`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`ALTER TABLE core.registry_proposals ENABLE TRIGGER catalog_proposal_reserved_key_guard`;
      await tx`ALTER TABLE core.claim_types ENABLE TRIGGER catalog_type_reserved_key_guard`;
      await tx`ALTER TABLE core.claims ENABLE TRIGGER catalog_claim_reserved_key_guard`;
    });
    const frozen = (await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${versionId}`)[0];
    const get = () => app.inject({ method: "GET", url: `/api/v1/public/registries/project/${frozen!.public_projection.projectKey}` });
    const confirm = async (status: "not_applicable" | "pending", version = 0) => {
      const steward = await signIn(app, fx.stewardA);
      const response = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/rights/confirmations`,
        headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey(), "if-match": `"${version}"` },
        payload: { status, factScope: "legacy", reason: "Only change the fixed legacy matrix" } });
      expect(response.statusCode, response.body).toBe(200);
    };
    const unchanged = async () => expect((await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${versionId}`)[0]).toEqual(frozen);
    return { claimId, catalogId, uploadId, attestationId, get, confirm, unchanged };
  }

  it.each(["missing", "age", "grade", "unreviewed", "rejected"] as const)("legacy exclusion cannot suppress historical catalog %s warnings", async kind => {
    const fixture = await historicalPublication({ evidence: kind !== "missing", reviewed: kind !== "missing", old: kind === "age", passingStage: kind === "grade", initialGrade: kind === "grade" ? "self_reported" : "verified", addedUnreviewed: kind === "unreviewed" });
    // Insert the weak grade directly so post-publication propagation cannot mask
    // the minimum-grade warning for an approved, positively reviewed item.
    if (kind === "rejected") await fx.sql`UPDATE core.claims SET grade='rejected' WHERE id=${fixture.claimId}`;
    const before = await fixture.get();
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().evidenceLedgerCurrent.warnings).toMatchObject([{ claimType, status: kind === "rejected" ? "rejected" : "needs_re_review" }]);
    await fixture.confirm("not_applicable");
    const after = await fixture.get();
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().evidenceLedgerCurrent.warnings).toEqual(before.json().evidenceLedgerCurrent.warnings);
    await fixture.unchanged();
  });

  it("does not interpret a new legacy exclusion as removal of an approved catalog stage", async () => {
    const fixture = await historicalPublication({ passingStage: true });
    expect((await fixture.get()).json().evidenceLedgerCurrent.warnings).toEqual([]);
    await fixture.confirm("not_applicable");
    expect((await fixture.get()).json().evidenceLedgerCurrent.warnings).toEqual([]);
    await fixture.unchanged();
  });

  it.each(["missing", "age", "grade"] as const)("preserves a frozen catalog exclusion for %s without reading later legacy decisions", async kind => {
    const fixture = await historicalPublication({ frozenExcluded: true, evidence: kind !== "missing", reviewed: kind !== "missing",
      old: kind === "age", initialGrade: kind === "grade" ? "self_reported" : "verified", passingStage: kind === "grade" });
    expect((await fixture.get()).json().evidenceLedgerCurrent.warnings).toEqual([]);
    await fixture.confirm("not_applicable");
    expect((await fixture.get()).json().evidenceLedgerCurrent.warnings).toEqual([]);
    await fixture.confirm("pending", 1);
    expect((await fixture.get()).json().evidenceLedgerCurrent.warnings).toEqual([]);
    await fixture.unchanged();
  });

  it.each(["stale", "rejected", "conflicting"] as const)("keeps actual %s warnings above a frozen catalog exclusion", async kind => {
    const fixture = await historicalPublication({ frozenExcluded: true });
    await fixture.confirm("not_applicable");
    await fixture.confirm("pending", 1);
    if (kind === "stale") await fx.sql`UPDATE core.claims SET stale_since=now(),stale_reason='Actual stale evidence' WHERE id=${fixture.claimId}`;
    if (kind === "rejected") await fx.sql`UPDATE core.claims SET grade='rejected' WHERE id=${fixture.claimId}`;
    if (kind === "conflicting") await fx.sql`INSERT INTO core.claim_conflicts(id,tenant_id,claim_id,conflict_type)
      VALUES(${randomUUID()},${fx.tenantA},${fixture.claimId},'contradiction')`;
    const current = await fixture.get();
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json().evidenceLedgerCurrent.warnings).toMatchObject([{ claimType,
      status: kind === "stale" ? "needs_re_review" : kind === "conflicting" ? "conflicting" : "rejected" }]);
    await fixture.unchanged();
  });

  it.each(["rights", "priority_custom"])("prioritizes actual invalidation, rejection and obligations for %s", async catalogKey => {
    const fixture = await historicalPublication({ catalogKey, passingStage: true, freshnessDays: "180" });
    expect((await fixture.get()).json().evidenceLedgerCurrent.warnings).toEqual([]);
    const addedId = randomUUID();
    const rollback = new Error("Rollback combined-priority fixture");
    const cases = ["rejected", "excluded", "stale", "invalid_review", "conflicting"] as const;
    for (const combination of cases) {
      await expect(fx.sql.begin(async tx => {
        // Model another active evidence item without a post-publication grade UPDATE:
        // provenance propagation must not accidentally mask the priority being tested.
        await tx`ALTER TABLE core.claims DISABLE TRIGGER catalog_claim_reserved_key_guard`;
        await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,as_of,excluded_by_rule)
          VALUES(${addedId},${fx.tenantA},${fx.projectA},${catalogKey},'New problematic evidence','{}',
            ${combination === "excluded" ? "self_reported" : "rejected"},${fixture.catalogId},1,'{}','2000-01-01',${combination === "excluded"})`;
        await tx`SET CONSTRAINTS ALL IMMEDIATE`;
        await tx`ALTER TABLE core.claims ENABLE TRIGGER catalog_claim_reserved_key_guard`;
        if (combination === "stale" || combination === "conflicting") await tx`UPDATE core.claims SET stale_since=now(),stale_reason='Actual invalidation' WHERE id=${addedId}`;
        if (combination === "invalid_review") await tx`UPDATE core.verification_attestations SET state='revoked' WHERE id=${fixture.attestationId}`;
        if (combination === "conflicting") await tx`INSERT INTO core.claim_conflicts(id,tenant_id,claim_id,conflict_type)
          VALUES(${randomUUID()},${fx.tenantA},${addedId},'contradiction')`;
        const expectedStatus = combination === "conflicting" ? "conflicting"
          : combination === "stale" || combination === "invalid_review" ? "needs_re_review" : "rejected";
        // Query in the writer transaction so the overlay sees exactly these uncommitted
        // conditions; existing public-API cases above cover the same wrapper and projection.
        const [version] = await tx`SELECT v.id FROM core.registry_entry_versions v
          JOIN core.registry_entries e ON e.id=v.entry_id AND e.tenant_id=v.tenant_id
          WHERE e.tenant_id=${fx.tenantA} AND e.subject_id=${fx.projectA}`;
        const [current] = await tx`SELECT core.public_evidence_ledger_current(${version!.id}) AS current`;
        expect(current!.current.warnings).toEqual([{ claimType: catalogKey, catalogVersion: "1", status: expectedStatus,
          reasons: [expectedStatus === "conflicting" ? "UNRESOLVED_CONFLICT"
            : expectedStatus === "rejected" ? "REJECTED_OR_EXCLUDED_EVIDENCE" : "EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT"] }]);
        if (catalogKey !== "rights") {
          const privateLedger = await computeEvidenceLedger(tx, fx.tenantA, fx.projectA, new Date());
          expect(privateLedger!.items.find(item => item.claimType === catalogKey)!.status).toBe(expectedStatus);
        }
        throw rollback;
      })).rejects.toBe(rollback);
    }
    await fixture.unchanged();
  });

});
