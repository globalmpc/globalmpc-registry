import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { projectProjection, publishProject } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

interface Upload {
  readonly id: string;
  readonly version: number;
}

interface Published {
  readonly projectId: string;
  readonly projectKey: string;
  readonly versionId: string;
  readonly documents: { readonly a: Upload; readonly b: Upload };
  readonly claims: { readonly a: string; readonly b: string };
  readonly attestations: { readonly a: string; readonly b: string };
  readonly projection: Record<string, unknown>;
  readonly frozen: unknown;
}

/**
 * A broken evidence chain: the document a published ledger item rests on is revoked or
 * replaced, directly or through a document it depends on (`core.document_impact_targets`).
 *
 * | Case | Authority | Input scope | Result |
 * | --- | --- | --- | --- |
 * | Claim's own document revoked or replaced | Existing document routes | That item only | needs_re_review |
 * | Upstream document revoked or replaced (one or more hops) | Existing document routes | Items whose documents rest on it | needs_re_review |
 * | Document no published item rests on revoked or replaced | Existing document routes | None | No warning |
 *
 * The approved projection and its hash are frozen; only the live overlay changes, and it uses
 * the existing public status and reason codes without disclosing private identifiers.
 */
describeDb("broken evidence chains in the published ledger", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let publisher: string;
  let steward: string;
  let scan: string;
  let policyId: string;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const typeA = `chain_licence_${suffix}`;
  const typeB = `chain_permit_${suffix}`;
  const requirementA = `chain-licence-requirement-${suffix}`;
  const requirementB = `chain-permit-requirement-${suffix}`;
  const catalog: Record<string, string> = {};
  const reason = ["EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT"];

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    publisher = await signIn(app, fx.disclosureApproverA);
    steward = await signIn(app, fx.stewardA);
    scan = await signIn(app, fx.scanServiceA);
    for (const claimType of [typeA, typeB]) {
      const proposal = randomUUID();
      const entry = randomUUID();
      catalog[claimType] = entry;
      const payload = {
        claimType,
        displayName: `Synthetic ${claimType}`,
        description: null,
        definition: { fields: [{ key: "number", label: "Number", type: "string", required: true }] },
      };
      await fx.sql.begin(async (tx) => {
        await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
          VALUES(${proposal},${fx.tenantA},'claim_type',${claimType},1,${tx.json(payload)},'Synthetic test','2020-01-01T00:00:00Z',${fx.operatorSubjectA})`;
        await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
          SELECT ${entry},tenant_id,item_key,1,payload->>'displayName',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposal}`;
        await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),
          decision_reason='Synthetic test only',materialized_id=${entry},version=2 WHERE id=${proposal}`;
      });
    }
    // One effective policy for every project in this file. A newer policy would itself warn on
    // every earlier publication and mask the input-scope assertions below.
    policyId = randomUUID();
    const requirement = (requirementId: string, claimType: string) => ({
      requirementId,
      label: `Synthetic ${claimType}`,
      appliesWhen: { op: "eq", path: "referenceStatus", value: "synthetic_test_project" },
      requiredClaimTypes: [claimType],
      minimumGrade: "verified",
      freshnessThresholdDays: null,
      requiredAttestations: ["professional_signoff"],
      blockingConflictTypes: [],
      notEvaluableWhen: { op: "never" },
      watchWhen: null,
    });
    const definition = {
      ruleSetId: `synthetic-chain-${suffix}`,
      version: "1.0.0",
      effectiveFrom: "2020-01-01T00:00:00Z",
      supersededBy: null,
      jurisdictionProfile: "MNG",
      gateId: "stage.exploration",
      retroactive: false,
      requirements: [requirement(requirementA, typeA), requirement(requirementB, typeB)],
    };
    await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
      VALUES(${policyId},${fx.tenantA},${definition.ruleSetId},'1.0.0','stage.exploration','MNG','2020-01-01T00:00:00Z',${fx.sql.json(definition)},'effective')`;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function headers(token: string, version?: number): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "idempotency-key": idempotencyKey(),
      ...(version === undefined ? {} : { "if-match": `"${version}"` }),
    };
  }

  async function current(document: Upload): Promise<Upload> {
    const [row] = await fx.sql<{ version: number }[]>`SELECT version FROM core.object_uploads WHERE id=${document.id}`;
    return { id: document.id, version: row!.version };
  }

  async function promoted(projectId: string): Promise<Upload> {
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/uploads`,
      headers: headers(steward),
      payload: {
        contentBase64: Buffer.from(`chain document ${randomUUID()}`).toString("base64"),
        contentType: "application/pdf",
        originalFilename: "chain.pdf",
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    return promote(uploaded.json() as Upload);
  }

  async function promote(document: Upload): Promise<Upload> {
    const scanned = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${document.id}/scan-result`,
      headers: headers(scan, document.version),
      payload: { result: "clean" },
    });
    expect(scanned.statusCode, scanned.body).toBe(200);
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${document.id}/promote`,
      headers: headers(steward, (scanned.json() as Upload).version),
      payload: {},
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json() as Upload;
  }

  async function link(projectId: string, upstream: Upload, downstream: Upload): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/document-links`,
      headers: headers(steward),
      payload: { upstreamUploadId: upstream.id, downstreamUploadId: downstream.id, kind: "depends_on" },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function revoke(document: Upload): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${document.id}/revoke`,
      headers: headers(steward, (await current(document)).version),
      payload: { reason: "Synthetic broken evidence chain" },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /** A promoted new version of `previous`, through the existing replacement route. */
  async function replace(projectId: string, previous: Upload): Promise<Upload> {
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/uploads`,
      headers: headers(steward),
      payload: {
        contentBase64: Buffer.from(`replacement ${randomUUID()}`).toString("base64"),
        contentType: "application/pdf",
        originalFilename: "replacement.pdf",
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const created = uploaded.json() as Upload;
    const marked = await app.inject({
      method: "PATCH",
      url: `/api/v1/uploads/${created.id}/document-profile`,
      headers: headers(steward, created.version),
      payload: { supersedesUploadId: previous.id },
    });
    expect(marked.statusCode, marked.body).toBe(200);
    return promote(marked.json() as Upload);
  }

  async function signedReview(projectId: string, claimId: string, state: "signed" | "active" = "signed") {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    const attestationId = randomUUID();
    const hash = `0x${"ab".repeat(32)}`;
    await fx.sql`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state)
      VALUES(${caseId},${fx.tenantA},${projectId},${fx.schemaA},'signed')`;
    await fx.sql`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id)
      VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA})`;
    await fx.sql`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
      evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
      VALUES(${attestationId},${fx.tenantA},${caseId},${assignmentId},${fx.credentialA},${fx.schemaA},'professional_signoff',${[claimId]}::uuid[],
      ${hash},'Synthetic scope; no legal validity opinion','{"status":"valid"}','1','1',${hash},${`0x${"12".repeat(65)}`},${fx.reviewerA.address},
      '2026-01-01T00:00:00Z',${state})`;
    return attestationId;
  }

  async function catalogClaim(projectId: string, claimType: string, documents: string[], receiptId: string | null = null) {
    const claimId = randomUUID();
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,
      structured_values,document_upload_ids,as_of,source_receipt_id)
      VALUES(${claimId},${fx.tenantA},${projectId},${claimType},${`Private value ${suffix}`},'{}','verified',${catalog[claimType]!},1,
      ${fx.sql.json({ number: `private-${claimId}` })},${documents}::uuid[],current_date,${receiptId})`;
    return claimId;
  }

  /** A receipt verified against `document`, the path document changes use to mark claims stale. */
  async function receiptOn(projectId: string, document: Upload): Promise<string> {
    const receiptId = randomUUID();
    await fx.sql`INSERT INTO core.source_receipts (
        id, tenant_id, project_id, connection_id, authority_id, collection_method,
        result, query_basis, endpoint_or_document_ref, authentication_method,
        raw_hash, source_schema_version, adapter_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        freshness_status, correlation_id, channel_evidence
      ) VALUES (
        ${receiptId}, ${fx.tenantA}, ${projectId}, ${fx.connectionA}, ${fx.authorityA},
        'authenticated_api', 'manual_review_required', '{}'::jsonb, 'document',
        'none', ${`0x${"11".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
        now(), now(), 'fresh', 'test', ${fx.sql.json({ documentUploadId: document.id })}
      )`;
    return receiptId;
  }

  /**
   * Two independently reviewed items approved and published together. Item B can rest on its
   * document through a source receipt and an active review, the path that reaches stale signals.
   */
  async function published(options: { receiptB?: boolean } = {}): Promise<Published> {
    const projectId = randomUUID();
    const projectKey = `CHAIN-${projectId.slice(0, 8)}`;
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id,reference_status)
      VALUES(${projectId},${fx.tenantA},${projectKey},'Synthetic broken chain','MNG',ARRAY['copper'],${fx.orgA},'synthetic_test_project')`;
    const a = await promoted(projectId);
    const b = await promoted(projectId);
    const claimA = await catalogClaim(projectId, typeA, [a.id]);
    const claimB = options.receiptB
      ? await catalogClaim(projectId, typeB, [], await receiptOn(projectId, b))
      : await catalogClaim(projectId, typeB, [b.id]);
    const attestationA = await signedReview(projectId, claimA);
    const attestationB = await signedReview(projectId, claimB, options.receiptB ? "active" : "signed");
    const assessed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/evidence-ledger`,
      headers: headers(operator),
      payload: {},
    });
    expect(assessed.statusCode, assessed.body).toBe(200);
    const snapshot = assessed.json().snapshot;
    expect(snapshot.currentStage).toBe("stage.exploration");
    expect(statuses(snapshot.items)).toEqual({ [typeA]: "reviewed", [typeB]: "reviewed" });
    const projection = assessed.json().publicProjection as Record<string, unknown>;
    const publication = await publishProject(app, fx.sql, { drafter: operator, publisher }, projectId, {
      projection: await projectProjection(fx.sql, projectId, { evidenceLedger: projection }),
    });
    expect(publication.statusCode, publication.body).toBe(200);
    const versionId = publication.json().id as string;
    const result: Published = {
      projectId,
      projectKey,
      versionId,
      documents: { a, b },
      claims: { a: claimA, b: claimB },
      attestations: { a: attestationA, b: attestationB },
      projection,
      frozen: await frozenRow(versionId),
    };
    // Baseline: an intact chain carries no live warning.
    await expectLive(result, { private: { [typeA]: "reviewed", [typeB]: "reviewed" }, warnings: [] });
    return result;
  }

  function statuses(items: { claimType: string; status: string }[]) {
    return Object.fromEntries(
      items.filter((item) => item.claimType === typeA || item.claimType === typeB).map((item) => [item.claimType, item.status]),
    );
  }

  async function frozenRow(versionId: string) {
    const [row] = await fx.sql`SELECT content_hash,public_projection,status FROM core.registry_entry_versions WHERE id=${versionId}`;
    return row;
  }

  function warning(claimType: string) {
    return { claimType, catalogVersion: "1", status: "needs_re_review", reasons: reason };
  }

  async function expectLive(
    record: Published,
    expected: { private: Record<string, string>; warnings: ReturnType<typeof warning>[]; extraPrivateIds?: string[] },
  ) {
    const privateLedger = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${record.projectId}/evidence-ledger`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(privateLedger.statusCode, privateLedger.body).toBe(200);
    expect(statuses(privateLedger.json().snapshot.items)).toEqual(expected.private);

    const response = await app.inject({ method: "GET", url: `/api/v1/public/registries/project/${record.projectKey}` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.entryVersionId).toBe(record.versionId);
    expect(body.evidenceLedger).toEqual(record.projection);
    expect(body.evidenceLedgerCurrent.warnings).toEqual(expected.warnings);
    // The overlay names only the approved public identity (claimType, catalogVersion).
    for (const privateValue of [
      record.claims.a, record.claims.b, record.attestations.a, record.attestations.b,
      record.documents.a.id, record.documents.b.id, policyId, requirementA, requirementB,
      `Private value ${suffix}`, `private-${record.claims.a}`, ...(expected.extraPrivateIds ?? []),
    ]) {
      expect(response.body).not.toContain(privateValue);
    }
    for (const privateKey of ["claimIds", "attestationIds", "policySetId", "inputBasis", "applicableStageRequirements", "uploadIds"]) {
      expect(response.body).not.toContain(`"${privateKey}"`);
    }
    expect(await frozenRow(record.versionId)).toEqual(record.frozen);
  }

  it("warns only the item whose own document is revoked", async () => {
    const record = await published();
    await revoke(record.documents.a);
    await expectLive(record, {
      private: { [typeA]: "needs_re_review", [typeB]: "reviewed" },
      warnings: [warning(typeA)],
    });
  });

  it("warns only the item whose own document is replaced by a new version", async () => {
    const record = await published();
    const successor = await replace(record.projectId, record.documents.b);
    await expectLive(record, {
      private: { [typeA]: "reviewed", [typeB]: "needs_re_review" },
      warnings: [warning(typeB)],
      extraPrivateIds: [successor.id],
    });
  });

  it("warns through a revoked upstream document, including more than one hop", async () => {
    const record = await published();
    const upstream = await promoted(record.projectId);
    const middle = await promoted(record.projectId);
    await link(record.projectId, upstream, middle);
    await link(record.projectId, middle, record.documents.a);
    // Linking alone is not a break.
    await expectLive(record, { private: { [typeA]: "reviewed", [typeB]: "reviewed" }, warnings: [] });
    await revoke(upstream);
    await expectLive(record, {
      private: { [typeA]: "needs_re_review", [typeB]: "reviewed" },
      warnings: [warning(typeA)],
      extraPrivateIds: [upstream.id, middle.id],
    });
  });

  it("warns through a replaced upstream document after its links move to the new version", async () => {
    const record = await published();
    const upstream = await promoted(record.projectId);
    await link(record.projectId, upstream, record.documents.b);
    const successor = await replace(record.projectId, upstream);
    const [moved] = await fx.sql`SELECT count(*)::int n FROM core.document_links
      WHERE upstream_upload_id=${successor.id} AND downstream_upload_id=${record.documents.b.id} AND removed_at IS NULL`;
    expect(moved!.n).toBe(1);
    await expectLive(record, {
      private: { [typeA]: "reviewed", [typeB]: "needs_re_review" },
      warnings: [warning(typeB)],
      extraPrivateIds: [upstream.id, successor.id],
    });
  });

  it("does not warn when documents no published item rests on are revoked or replaced", async () => {
    const record = await published();
    const unrelated = await promoted(record.projectId);
    const unrelatedUpstream = await promoted(record.projectId);
    const unrelatedDownstream = await promoted(record.projectId);
    const replaced = await promoted(record.projectId);
    // A downstream document of the claim's document is not its evidence.
    await link(record.projectId, record.documents.a, unrelatedDownstream);
    await link(record.projectId, unrelatedUpstream, unrelatedDownstream);
    await revoke(unrelated);
    await revoke(unrelatedUpstream);
    await revoke(unrelatedDownstream);
    const successor = await replace(record.projectId, replaced);
    await expectLive(record, {
      private: { [typeA]: "reviewed", [typeB]: "reviewed" },
      warnings: [],
      extraPrivateIds: [unrelated.id, unrelatedUpstream.id, unrelatedDownstream.id, replaced.id, successor.id],
    });
  });

  it("keeps a receipt-backed break on its own item when the stale review raises a project signal", async () => {
    const record = await published({ receiptB: true });
    await revoke(record.documents.b);
    // The existing chain marks the receipt claim stale, its active review stale_candidate,
    // and leaves an open signal on the published version.
    const [claim] = await fx.sql`SELECT stale_since FROM core.claims WHERE id=${record.claims.b}`;
    expect(claim!.stale_since).not.toBeNull();
    const signals = await fx.sql`SELECT origin_attestation_id FROM core.evidence_stale_signals
      WHERE target_type='registry_entry_version' AND target_id=${record.versionId} AND resolution='open'`;
    expect(signals.map((signal) => signal.origin_attestation_id)).toEqual([record.attestations.b]);
    await expectLive(record, {
      private: { [typeA]: "reviewed", [typeB]: "needs_re_review" },
      warnings: [warning(typeB)],
    });
  });

  it("keeps a review outside every approved item off the overlay while CRE status stays record-level stale", async () => {
    const record = await published();
    const creReport = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${record.projectId}/cre-reports`,
        headers: headers(operator),
        payload: {
          publicKey: record.projectKey,
          chainId: String(loadConfig(testEnv()).chainId),
          receiver: `0x${"12".repeat(20)}`,
          ttlSeconds: "300",
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as { status: number; contentHash: string };
    };
    const fresh = await creReport();
    expect(fresh.status).toBe(1);
    // A legacy (non-catalog) claim is in no approved item. Its active review goes stale through
    // the existing document-revocation chain, which opens a signal on the published version.
    const legacyDocument = await promoted(record.projectId);
    const legacyClaim = randomUUID();
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,source_receipt_id)
      VALUES(${legacyClaim},${fx.tenantA},${record.projectId},'lab_accreditation',${`Legacy private ${suffix}`},'{}','verified',
      ${await receiptOn(record.projectId, legacyDocument)})`;
    const legacyReview = await signedReview(record.projectId, legacyClaim, "active");
    await revoke(legacyDocument);
    const [review] = await fx.sql`SELECT state FROM core.verification_attestations WHERE id=${legacyReview}`;
    expect(review!.state).toBe("stale_candidate");
    const signals = await fx.sql`SELECT origin_attestation_id FROM core.evidence_stale_signals
      WHERE target_type='registry_entry_version' AND target_id=${record.versionId} AND resolution='open'`;
    expect(signals.map((signal) => signal.origin_attestation_id)).toEqual([legacyReview]);
    await expectLive(record, {
      private: { [typeA]: "reviewed", [typeB]: "reviewed" },
      warnings: [],
      extraPrivateIds: [legacyClaim, legacyReview, legacyDocument.id, `Legacy private ${suffix}`],
    });
    // The on-chain observation is record-level and fails closed on any open version signal.
    const stale = await creReport();
    expect(stale.status).toBe(2);
    expect(stale.contentHash).toBe(fresh.contentHash);
    expect(await frozenRow(record.versionId)).toEqual(record.frozen);
  });

  it("scopes an open version signal to its review's items and keeps unknown origins conservative", async () => {
    const record = await published();
    const signal = async (origin: string | null) => {
      const id = randomUUID();
      await fx.sql`INSERT INTO core.evidence_stale_signals(id,tenant_id,project_id,target_type,target_id,origin_attestation_id,reason)
        VALUES(${id},${fx.tenantA},${record.projectId},'registry_entry_version',${record.versionId},${origin},'Synthetic version signal')`;
      return id;
    };
    const dismiss = (id: string) => fx.sql`UPDATE core.evidence_stale_signals
      SET resolution='dismissed',resolved_at=now(),resolution_note='Synthetic dismissal' WHERE id=${id}`;
    // Only the signal changes; both reviews and documents stay current.
    const scoped = await signal(record.attestations.a);
    await expectLive(record, { private: { [typeA]: "reviewed", [typeB]: "reviewed" }, warnings: [warning(typeA)] });
    await dismiss(scoped);
    const unknown = await signal(null);
    await expectLive(record, {
      private: { [typeA]: "reviewed", [typeB]: "reviewed" },
      warnings: [warning(typeA), warning(typeB)],
    });
    await dismiss(unknown);
    await expectLive(record, { private: { [typeA]: "reviewed", [typeB]: "reviewed" }, warnings: [] });
  });
});
