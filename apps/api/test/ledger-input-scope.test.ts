import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { evidenceLedgerSemantic } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { draftRegistryEntry, projectKeyOf, projectProjection, publishDraft } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("ledger publication compares only relevant catalog inputs", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  beforeEach(async () => { fx = await setupFixture(); app = await buildServer(loadConfig(testEnv()), fx.appSql); });
  afterEach(async () => { await app?.close(); await fx?.close(); });

  async function prepare(scope: "reserved" | "retained" | "mixed", retainedClaimPresent = true) {
    const visibleType = `visible_${randomUUID().replaceAll("-", "")}`;
    const reservedClaim = randomUUID(), retainedClaim = randomUUID(), attestationId = randomUUID();
    await fx.sql.begin(async tx => {
      // Import only historical reserved rows, with the new-key guards restored before
      // invoking the API. All content/signature immutability and tenant guards remain on.
      await tx`ALTER TABLE core.registry_proposals DISABLE TRIGGER catalog_proposal_reserved_key_guard`;
      await tx`ALTER TABLE core.claim_types DISABLE TRIGGER catalog_type_reserved_key_guard`;
      await tx`ALTER TABLE core.claims DISABLE TRIGGER catalog_claim_reserved_key_guard`;
      for (const [key, claim] of [["rights", reservedClaim], [visibleType, retainedClaim]] as const) {
        const proposalId = randomUUID(), catalogId = randomUUID();
        const payload = { claimType: key, displayName: key, description: null, definition: { fields: [] } };
        await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
          VALUES(${proposalId},${fx.tenantA},'claim_type',${key},1,${tx.json(payload)},'Historical scope fixture',now(),${fx.operatorSubjectA})`;
        await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
          SELECT ${catalogId},tenant_id,item_key,1,item_key,payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposalId}`;
        await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Scope fixture',materialized_id=${catalogId},version=2 WHERE id=${proposalId}`;
        if (key === "rights" || retainedClaimPresent) await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,catalog_entry_id,catalog_version,structured_values)
          VALUES(${claim},${fx.tenantA},${fx.projectA},${key},'Scope fixture','{}',${catalogId},1,'{}')`;
      }
      const caseId = randomUUID(), assignmentId = randomUUID();
      await tx`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state)
        VALUES(${caseId},${fx.tenantA},${fx.projectA},${fx.schemaA},'signed')`;
      await tx`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id)
        VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA})`;
      const claimScope = scope === "reserved" ? [reservedClaim] : scope === "retained" ? [retainedClaim] : [reservedClaim, retainedClaim];
      const hash = "0x"+"ab".repeat(32);
      await tx`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
        evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
        VALUES(${attestationId},${fx.tenantA},${caseId},${assignmentId},${fx.credentialA},${fx.schemaA},'professional_signoff',${claimScope}::uuid[],
        ${hash},'Scope fixture','{"status":"valid"}','1','1',${hash},${"0x"+"12".repeat(65)},${fx.reviewerA.address},now(),'signed')`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`ALTER TABLE core.registry_proposals ENABLE TRIGGER catalog_proposal_reserved_key_guard`;
      await tx`ALTER TABLE core.claim_types ENABLE TRIGGER catalog_type_reserved_key_guard`;
      await tx`ALTER TABLE core.claims ENABLE TRIGGER catalog_claim_reserved_key_guard`;
    });
    const drafter = await signIn(app, fx.operatorA), publisher = await signIn(app, fx.disclosureApproverA);
    const assess = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/evidence-ledger`,
      headers: { authorization: `Bearer ${drafter}`, "idempotency-key": idempotencyKey() }, payload: {} });
    expect(assess.statusCode, assess.body).toBe(200);
    const drafted = await draftRegistryEntry(app, drafter, { registryType: "project", subjectId: fx.projectA,
      publicKey: await projectKeyOf(fx.sql, fx.projectA),
      projection: await projectProjection(fx.sql, fx.projectA, { evidenceLedger: assess.json().publicProjection }), policyVersion: "1", schemaVersion: "1" });
    expect(drafted.statusCode, drafted.body).toBe(200);
    const current = async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/projects/${fx.projectA}/evidence-ledger`, headers: { authorization: `Bearer ${drafter}` } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().snapshot;
    };
    return { visibleType, reservedClaim, retainedClaim, attestationId, snapshot: assess.json().snapshot, current,
      publish: () => publishDraft(app, publisher, drafted.json()) };
  }

  it.each(["reserved", "retained", "mixed"] as const)("handles a %s attestation state change without losing mixed-scope reviews", async scope => {
    const fixture = await prepare(scope);
    expect(fixture.snapshot.inputBasis.attestations.map((a: { id: string }) => a.id)).toEqual(scope === "reserved" ? [] : [fixture.attestationId]);
    if (scope === "mixed") expect(fixture.snapshot.inputBasis.attestations[0].claim_scope).toEqual([fixture.reservedClaim, fixture.retainedClaim]);
    // Both states are valid, so visible conclusions remain identical. Only relevant
    // review metadata belongs in the approved private input basis.
    await fx.sql`UPDATE core.verification_attestations SET state='active' WHERE id=${fixture.attestationId}`;
    const current = await fixture.current();
    expect(current.items).toEqual(fixture.snapshot.items);
    const publication = await fixture.publish();
    if (scope === "reserved") {
      expect(evidenceLedgerSemantic(current)).toEqual(evidenceLedgerSemantic(fixture.snapshot));
      expect(publication.statusCode, publication.body).toBe(200);
    } else {
      expect(publication.statusCode, publication.body).toBe(422);
      expect(publication.json().code).toBe("PUBLICATION_LEDGER_STALE");
    }
  });

  it.each(["legacy", "catalog", "catalog_without_claim"] as const)("scopes %s applicability decisions before comparing publication inputs", async scope => {
    const fixture = await prepare("reserved", scope !== "catalog_without_claim");
    const steward = await signIn(app, fx.stewardA);
    const key = scope === "legacy" ? "rights" : fixture.visibleType;
    const confirmed = await app.inject({ method: "POST", url: `/api/v1/projects/${fx.projectA}/facts/${key}/confirmations`,
      headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey(), "if-match": '"0"' },
      payload: { status: "not_applicable", reason: "Only change the selected namespace", factScope: scope === "legacy" ? "legacy" : "catalog" } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const current = await fixture.current();
    const publication = await fixture.publish();
    if (scope === "legacy") {
      expect(current.inputBasis.manual).toEqual([]);
      expect(evidenceLedgerSemantic(current)).toEqual(evidenceLedgerSemantic(fixture.snapshot));
      expect(publication.statusCode, publication.body).toBe(200);
    } else {
      expect(current.inputBasis.manual).toMatchObject([{ fact_key: fixture.visibleType, status: "not_applicable" }]);
      expect(publication.statusCode, publication.body).toBe(422);
      expect(publication.json().code).toBe("PUBLICATION_LEDGER_STALE");
    }
  });
});
