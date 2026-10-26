import type postgres from "postgres";
import { PROJECT_FACT_KEYS } from "@mpc/api-contract";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { snapshotClaimFingerprint, hashSnapshotInput, type SnapshotClaimRow } from "../src/services/evidence-snapshot.js";
import { resolveCatalogClaim } from "../src/services/catalog-claims.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, signIn, testEnv, idempotencyKey, type TestFixture } from "./helpers/db.js";
import { publishProject, projectProjection, projectKeyOf } from "./helpers/registry.js";

it("rejects legacy document attachments before any evidence can escape the signed fingerprint", async () => {
  const query = vi.fn();
  await expect(resolveCatalogClaim(query as unknown as postgres.TransactionSql, randomUUID(), "legacy", {
    documentUploadIds: [randomUUID()],
  })).rejects.toMatchObject({ code: "CLAIM_CATALOG_REQUIRED", statusCode: 422 });
  expect(query).not.toHaveBeenCalled();
  await expect(resolveCatalogClaim(query as unknown as postgres.TransactionSql, randomUUID(), "legacy", {}))
    .resolves.toMatchObject({ catalogEntryId: null, documentUploadIds: [] });
});

it.each(PROJECT_FACT_KEYS)("rejects existing catalog collisions with reserved manual key %s", async (claimType) => {
  const query = vi.fn();
  await expect(resolveCatalogClaim(query as unknown as postgres.TransactionSql, randomUUID(), claimType, {
    catalogEntryId: randomUUID(), structuredValues: {},
  })).rejects.toMatchObject({ code: "CLAIM_TYPE_RESERVED", statusCode: 422 });
  expect(query).not.toHaveBeenCalled();
});

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("approved manual exclusion with unreviewed evidence", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;
  let publisher: string;
  let steward: string;
  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA);
    publisher = await signIn(app, fx.disclosureApproverA);
    steward = await signIn(app, fx.stewardA);
  });
  afterAll(async () => { await app.close(); await fx.close(); });

  it("rejects legacy attachments through both the authenticated API and direct DB inserts", async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
      payload: { claimType: "legacy_evidence", valueText: "Legacy evidence", sourceCoordinate: {}, documentUploadIds: [randomUUID()] } });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().code).toBe("CLAIM_CATALOG_REQUIRED");
    const documentId = randomUUID();
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state)
      VALUES(${documentId},${fx.tenantA},${fx.projectA},${documentId},${"0x"+"ab".repeat(32)},123,'application/pdf','restricted','scanned_clean')`;
    await expect(fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,document_upload_ids)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},'legacy_evidence','Legacy evidence','{}',${[documentId]}::uuid[])`)
      .rejects.toThrow("Claim document attachments require a catalog entry");
  });

  it("corrects historical legacy attachments without inheriting unsigned links or rewriting history", async () => {
    const documentId = randomUUID(), claimId = randomUUID();
    await fx.sql.begin(async tx => {
      await tx`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state)
        VALUES(${documentId},${fx.tenantA},${fx.projectA},${documentId},${"0x"+"cd".repeat(32)},123,'application/pdf','restricted','scanned_clean')`;
      // Simulate data written before0089. The bypass exists only while seeding this
      // isolated transaction, and is restored before any authenticated API request.
      await tx`ALTER TABLE core.claims DISABLE TRIGGER legacy_claim_document_guard`;
      await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,document_upload_ids)
        VALUES(${claimId},${fx.tenantA},${fx.projectA},'historical_legacy','Original value','{}',${[documentId]}::uuid[])`;
      await tx`ALTER TABLE core.claims ENABLE TRIGGER legacy_claim_document_guard`;
    });
    const readOld = async () => (await fx.sql<SnapshotClaimRow[]>`SELECT id,value_text,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids
      FROM core.claims WHERE id=${claimId}`)[0]!;
    const fingerprint = (row: SnapshotClaimRow) => hashSnapshotInput({ claimIds: [row.id], artifactIds: [], receiptIds: [], claimFingerprints: [snapshotClaimFingerprint(row)] });
    const original = await readOld(), hash = fingerprint(original);
    const correct = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/v1/claims/${claimId}/versions`,
      headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey(), "if-match": '"1"' },
      payload: { valueText: "Corrected value", sourceCoordinate: {}, reason: "Correct the historical text", ...extra } });
    const explicit = await correct({ documentUploadIds: [documentId] });
    expect(explicit.statusCode, explicit.body).toBe(422);
    expect(explicit.json().code).toBe("CLAIM_CATALOG_REQUIRED");
    const corrected = await correct();
    expect(corrected.statusCode, corrected.body).toBe(200);
    const [newClaim] = await fx.sql`SELECT catalog_entry_id,document_upload_ids,supersedes_claim_id FROM core.claims WHERE id=${corrected.json().id}`;
    expect(newClaim).toMatchObject({ catalog_entry_id: null, document_upload_ids: [], supersedes_claim_id: claimId });
    expect(await fx.sql`SELECT id FROM core.lineage_edges WHERE from_id=${corrected.json().id} AND relation_type='derived_from' AND to_id=${documentId}`).toEqual([]);
    expect(await readOld()).toEqual(original);
    expect(fingerprint(await readOld())).toBe(hash);
    const [guard] = await fx.sql`SELECT tgenabled FROM pg_trigger WHERE tgname='legacy_claim_document_guard' AND tgrelid='core.claims'::regclass`;
    expect(guard!.tgenabled).toBe("O");
  });

  it("keeps approved exclusions quiet with unreviewed claims, but preserves health and withdrawal warnings", async () => {
    const catalogId = randomUUID(), proposal = randomUUID(), claimId = randomUUID();
    const claimType = `excluded_${randomUUID().replaceAll("-", "")}`;
    const payload = { claimType, displayName: "Excluded evidence", description: null, definition: { fields: [] } };
    await fx.sql.begin(async tx => {
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${proposal},${fx.tenantA},'claim_type',${claimType},1,${tx.json(payload)},'Synthetic test',now(),${fx.operatorSubjectA})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        SELECT ${catalogId},tenant_id,item_key,1,'Excluded evidence',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposal}`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Synthetic test',materialized_id=${catalogId},version=2 WHERE id=${proposal}`;
      await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,as_of)
        VALUES(${claimId},${fx.tenantA},${fx.projectA},${claimType},'Excluded old evidence','{}','unverified',${catalogId},1,'{}',DATE '2000-01-01')`;
      await tx`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
        VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},${claimType},1,'not_applicable','Excluded before approval',${fx.operatorSubjectA})`;
    });
    const assessed = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/evidence-ledger`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() }, payload: {} });
    expect(assessed.statusCode, assessed.body).toBe(200);
    expect(assessed.json().snapshot.items.find((item: { claimType: string }) => item.claimType === claimType).status).toBe("not_applicable");
    const projection = assessed.json().publicProjection;
    const publication = await publishProject(app, fx.sql, { drafter: token, publisher }, fx.projectA,
      { projection: await projectProjection(fx.sql, fx.projectA, { evidenceLedger: projection }) });
    expect(publication.statusCode, publication.body).toBe(200);
    const [before] = await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    const url = `/api/v1/public/registries/project/${await projectKeyOf(fx.sql, fx.projectA)}`;
    const current = await app.inject({ method: "GET", url });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json().evidenceLedgerCurrent.warnings).toEqual([]);
    // An exclusion suppresses only absent evidence/review, never unsafe evidence.
    for (const status of ["needs_re_review", "rejected", "conflicting"]) {
      const rollback = new Error("Rollback unsafe excluded evidence");
      await expect(fx.sql.begin(async tx => {
        if (status === "needs_re_review") await tx`UPDATE core.claims SET stale_since=now(),stale_reason='Synthetic stale signal' WHERE id=${claimId}`;
        if (status === "rejected") await tx`UPDATE core.claims SET grade='rejected' WHERE id=${claimId}`;
        if (status === "conflicting") await tx`INSERT INTO core.claim_conflicts(id,tenant_id,claim_id,conflict_type)
          VALUES(${randomUUID()},${fx.tenantA},${claimId},'contradiction')`;
        const [live] = await tx`SELECT core.public_evidence_ledger_current(${publication.json().id}) AS current`;
        expect(live!.current.warnings).toMatchObject([{ claimType, status }]);
        throw rollback;
      })).rejects.toBe(rollback);
    }
    await fx.sql`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},${claimType},2,'pending','Exclusion withdrawn',${fx.operatorSubjectA})`;
    const withdrawn = await app.inject({ method: "GET", url });
    expect(withdrawn.json().evidenceLedgerCurrent.warnings).toEqual([{ claimType, catalogVersion: "1", status: "needs_re_review", reasons: ["EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT"] }]);
    expect(withdrawn.json().evidenceLedger).toEqual(projection);
    const [after] = await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    expect(after).toEqual(before);
  });
});
