import type postgres from "postgres";
import { hashToken } from "../src/plugins/session-token.js";
import { administratorProjectProjection, PROJECT_PUBLICATION_DISCLAIMERS, PROJECT_PUBLICATION_LIMITATIONS } from "@mpc/api-contract";
import { withActor } from "@mpc/db";
import { addGovernanceAccount } from "./helpers/governance-accounts.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { verifyMerkleProof, hashLeaf, type Hex } from "@mpc/canonical";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
import { draftRegistryEntry, projectProjection, publishDraft } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("Registry publication and public lookup", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorA: string; stewardA: string; disclosureApproverA: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // Tests hold an account session (`signIn` issues one for the person holding the key).
    tokens = {
      operatorA: await signIn(app, fx.operatorA),
      stewardA: await signIn(app, fx.stewardA),
      disclosureApproverA: await signIn(app, fx.disclosureApproverA),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function validProjection(overrides: Record<string, unknown> = {}) {
    return {
      stableId: randomUUID(),
      status: "registered",
      version: "1",
      asOf: "2026-08-01T00:00:00.000Z",
      sourceAge: "12",
      staleStatus: "fresh",
      limitations: ["Legal rights verification is outside this review scope"],
      legalEffect: "none",
      disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
      ...overrides,
    };
  }

  /**
   * The Project Registry key is the project's key, so a test that names a key gets a project
   * with that key — naming the same key twice publishes two versions of one entry.
   */
  const projectsByKey = new Map<string, string>();
  async function projectWithKey(projectKey: string): Promise<string> {
    const known = projectsByKey.get(projectKey);
    if (known) return known;
    const projectId = randomUUID();
    await fx.sql`
      INSERT INTO core.projects (
        id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${projectKey}, 'Registry fixture', 'MNG',
        ARRAY['copper'], ${fx.orgA}
      )
    `;
    projectsByKey.set(projectKey, projectId);
    return projectId;
  }

  /** Drafts as `wallet`; publishes as the Disclosure Approver when the draft succeeds. */
  async function draft(wallet: string, overrides: Record<string, unknown> = {}) {
    const { publicKey: requestedKey, subjectId: requestedSubject, ...rest } = overrides;
    const publicKey = (requestedKey as string | undefined) ?? `KEY-${randomUUID().slice(0, 8)}`;
    const subjectId = (requestedSubject as string | undefined) ?? (await projectWithKey(publicKey));
    const [project] = await fx.sql<{ project_key: string }[]>`
      SELECT project_key FROM core.projects WHERE id = ${subjectId}
    `;
    return draftRegistryEntry(app, wallet, {
      registryType: "project",
      subjectId,
      publicKey: requestedKey ?? project?.project_key ?? publicKey,
      projection: project ? await projectProjection(fx.sql, subjectId) : validProjection(),
      policyVersion: "mn-core-1.0.0",
      schemaVersion: "project-registry-1",
      ...rest,
    });
  }

  async function publish(wallet: string, overrides: Record<string, unknown> = {}) {
    const drafted = await draft(wallet, overrides);
    if (drafted.statusCode !== 200) return drafted;
    return publishDraft(app, tokens.disclosureApproverA, drafted.json());
  }

  it("does not distinguish missing registry targets from targets outside an actor's scope", async () => {
    const prepared = await draft(tokens.operatorA);
    expect(prepared.statusCode,prepared.body).toBe(200);
    const published = await publishDraft(app,tokens.disclosureApproverA,prepared.json());
    expect(published.statusCode,published.body).toBe(200);
    const subjectId = prepared.json().subjectId;
    const reader = await signIn(app,fx.readerA);
    const scoped = await signIn(app,await addGovernanceAccount(fx,"administrator",{projectId:fx.projectA,assurance:"high_assurance"}));
    for (const token of [reader,scoped]) {
      for (const existing of [true,false]) {
        const key = existing ? prepared.json().id : randomUUID();
        const headers = {authorization:`Bearer ${token}`,"idempotency-key":idempotencyKey(),"if-match":'"1"'};
        const requests = [
          {url:"/api/v1/registry-entries",payload:{registryType:"project",subjectId:existing ? subjectId : randomUUID(),publicKey:"SCOPE-PROBE",projection:validProjection(),policyVersion:"1",schemaVersion:"1"}},
          {url:`/api/v1/registry-entries/drafts/${key}/publish`,payload:{}},
          {url:`/api/v1/registry-entries/drafts/${key}/reject`,payload:{reason:"Scope check"}},
          {url:`/api/v1/registry-entries/${existing ? published.json().entryId : randomUUID()}/revoke`,payload:{reasonCode:"Scope check"}},
        ];
        for (const request of requests) {
          const response = await app.inject({method:"POST",headers,...request});
          expect(response.statusCode,response.body).toBe(403);
          expect(response.json()).toMatchObject({code:"AUTHORIZATION_DENIED",message:"You do not have permission to perform this action"});
        }
      }
    }
  });

  /**
   * 04 §4.3 — the guard for `draft→registered` is "Project Registry minimum fields
   * and accountable party".
   *
   * The act that satisfies it is Project Registry publication. It is done by someone who
   * already holds `registry.publish`, so no new permission arises.
   * The remaining transitions (suspend, offering, closure) have no decided owner yet.
   */
  describe("project lifecycle (04 §4.3)", () => {
    async function newProject() {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {
          projectKey: `LC-${randomUUID().slice(0, 8)}`,
          name: "lifecycle test",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId: fx.orgA,
        },
      });
      expect(response.statusCode).toBe(200);
      const created = response.json();
      expect(created.lifecycleState).toBe("draft");
      return created.id as string;
    }

    async function lifecycleOf(projectId: string) {
      const [row] = await fx.sql<{ lifecycle_state: string }[]>`
        SELECT lifecycle_state FROM core.projects WHERE id = ${projectId}
      `;
      return row!.lifecycle_state;
    }

    it("project registry publication moves draft to registered", async () => {
      const projectId = await newProject();

      const response = await publish(tokens.operatorA, { subjectId: projectId });
      expect(response.statusCode).toBe(200);

      expect(await lifecycleOf(projectId)).toBe("registered");
    });

    it("republishing the same project stays registered", async () => {
      // The transition happens once. Repeating it would be `registered→registered`, which is
      // not in the 04 §4.3 transition table.
      const projectId = await newProject();
      await publish(tokens.operatorA, { subjectId: projectId });
      const again = await publish(tokens.operatorA, { subjectId: projectId });

      expect(again.statusCode).toBe(200);
      expect(await lifecycleOf(projectId)).toBe("registered");
    });

    it("verification registry publication does not touch the project lifecycle", async () => {
      // The Verification Registry records review outcomes. It does not mean the project is
      // registered.
      const projectId = await newProject();
      const attestationId = await seedAttestation(projectId, "signed");

      const drafted = await draftRegistryEntry(app, tokens.operatorA, {
        registryType: "verification",
        subjectId: attestationId,
        publicKey: `VER-${randomUUID().slice(0, 8)}`,
        projection: validProjection({ stableId: attestationId, status: "signed" }),
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "verification-registry-1",
      });
      expect(drafted.statusCode).toBe(200);
      const response = await publishDraft(app, tokens.disclosureApproverA, drafted.json());
      expect(response.statusCode).toBe(200);

      expect(await lifecycleOf(projectId)).toBe("draft");
    });
  });

  it("publishes when only allowlisted fields are present", async () => {
    const response = await publish(tokens.operatorA);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe("published");
    expect(body.version).toBe(1);
    expect(body.contentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("AC-22: rejects fields outside the allowlist", async () => {
    const response = await publish(tokens.operatorA, {
      projection: validProjection({ rawSourceResponse: "{...}" }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().details.offendingFields).toContain("rawSourceResponse");
  });

  it("AC-22: rejects raw-text and PII-like fields", async () => {
    for (const field of [
      "personalIdentifier",
      "contractBody",
      "preciseGeologicalCoordinates",
      "kycData",
      "whistleblowerIdentity",
    ]) {
      const response = await publish(tokens.operatorA, {
        projection: validProjection({ [field]: "leak" }),
      });
      expect(response.statusCode, field).toBe(422);
    }
  });

  describe("AC-32: person-level identifiers (05 §5.9)", () => {
    const record = {
      lawfulBasis: "Written consent of the named person, 2026-08-01",
      purpose: "Identify the signing competent person to readers",
      retention: "For the life of the public record",
      irreversibilityAcknowledged: true,
    };

    it("cannot draft person-level identifiers without the safeguards on record", async () => {
      const response = await draft(tokens.operatorA, { containsPersonLevelIdentifier: true });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("PUBLICATION_PERSON_IDENTIFIER_GUARD");
    });

    it("safeguards are a record, not booleans the client asserts", async () => {
      const response = await draft(tokens.operatorA, {
        containsPersonLevelIdentifier: true,
        personIdentifierSafeguards: {
          lawfulBasisRecorded: true,
          explicitPublicationApproval: true,
          purposeRecorded: true,
          retentionRecorded: true,
          irreversibilityAcknowledged: true,
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it("publication needs the approver's explicit approval of the identifiers", async () => {
      const drafted = await draft(tokens.operatorA, {
        containsPersonLevelIdentifier: true,
        personIdentifierRecord: record,
      });
      expect(drafted.statusCode).toBe(200);

      const response = await publishDraft(app, tokens.disclosureApproverA, drafted.json());
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("PUBLICATION_PERSON_IDENTIFIER_GUARD");
    });

    it("records who drafted the safeguards and who approved, with times", async () => {
      const drafted = await draft(tokens.operatorA, {
        containsPersonLevelIdentifier: true,
        personIdentifierRecord: record,
      });
      const published = await publishDraft(app, tokens.disclosureApproverA, drafted.json(), {
        personIdentifierPublicationApproved: true,
      });
      expect(published.statusCode).toBe(200);

      const [row] = await fx.sql<
        {
          lawful_basis: string;
          purpose: string;
          retention: string;
          irreversibility_acknowledged_at: Date | null;
          proposed_by_subject_id: string;
          decided_by_subject_id: string;
          decided_at: Date | null;
          person_identifier_publication_approved: boolean;
        }[]
      >`
        SELECT lawful_basis, purpose, retention, irreversibility_acknowledged_at,
               proposed_by_subject_id, decided_by_subject_id, decided_at,
               person_identifier_publication_approved
        FROM core.registry_publication_drafts WHERE id = ${drafted.json().id}
      `;
      expect(row!.lawful_basis).toBe(record.lawfulBasis);
      expect(row!.purpose).toBe(record.purpose);
      expect(row!.retention).toBe(record.retention);
      expect(row!.irreversibility_acknowledged_at).not.toBeNull();
      expect(row!.proposed_by_subject_id).toBe(fx.operatorSubjectA);
      expect(row!.decided_by_subject_id).not.toBe(fx.operatorSubjectA);
      expect(row!.decided_at).not.toBeNull();
      expect(row!.person_identifier_publication_approved).toBe(true);
    });
  });

  describe("AC-13: commercial reuse comes from the source receipts", () => {
    async function receiptFor(projectId: string, commercialReuse: string): Promise<void> {
      await fx.sql`
        INSERT INTO core.source_receipts (
          id, project_id, connection_id, authority_id, collection_method,
          result, query_basis, endpoint_or_document_ref, authentication_method,
          raw_hash, source_schema_version, adapter_version, terms_license,
          commercial_reuse, disclosure_permission, received_at, as_of,
          freshness_status, correlation_id
        ) VALUES (
          ${randomUUID()}, ${projectId}, ${fx.connectionA}, ${fx.authorityA},
          'manual_official_registry_confirmation', 'source_returned_no_record', '{}'::jsonb,
          'https://x.test/a', 'none', ${`0x${"11".repeat(32)}`}, '1', '1', 'CC-BY-4.0',
          ${commercialReuse}, 'public', now(), now(), 'fresh', 'test'
        )
      `;
    }

    it("the client cannot state the commercial-reuse status", async () => {
      const response = await draft(tokens.operatorA, {
        commercialReuse: "confirmed",
        publishedAsCommercialBasis: true,
      });
      expect(response.statusCode).toBe(400);
    });

    it("a project without receipts cannot back a commercial publication", async () => {
      const response = await draft(tokens.operatorA, { publishedAsCommercialBasis: true });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("PUBLICATION_SOURCE_LICENSE_UNCONFIRMED");
      expect(response.json().details.commercialReuse).toBe("unconfirmed");
    });

    it("confirmed receipts allow it, and one prohibited receipt blocks it again", async () => {
      const projectId = await projectWithKey(`CR-${randomUUID().slice(0, 8)}`);
      await receiptFor(projectId, "confirmed");

      const allowed = await draft(tokens.operatorA, {
        subjectId: projectId,
        publishedAsCommercialBasis: true,
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().commercialReuse).toBe("confirmed");
      await app.inject({
        method: "POST",
        url: `/api/v1/registry-entries/drafts/${allowed.json().id}/reject`,
        headers: {
          authorization: `Bearer ${tokens.disclosureApproverA}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${allowed.json().version}"`,
        },
        payload: { reason: "Superseded by a new receipt" },
      });

      await receiptFor(projectId, "prohibited");
      const blocked = await draft(tokens.operatorA, {
        subjectId: projectId,
        publishedAsCommercialBasis: true,
      });
      expect(blocked.statusCode).toBe(422);
      expect(blocked.json().details.commercialReuse).toBe("prohibited");
    });
  });

  /** A signed attestation on `projectId`, the subject of a Verification Registry entry. */
  async function seedAttestation(projectId: string, state: string): Promise<string> {
    const caseId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_cases (id, project_id, schema_id, state)
      VALUES (${caseId}, ${projectId}, ${fx.schemaA}, 'draft')
    `;
    const assignmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.assignments (id, case_id, subject_id, credential_id)
      VALUES (${assignmentId}, ${caseId}, ${fx.reviewerSubjectA}, ${fx.credentialA})
    `;
    const claimId = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, project_id, claim_type, value_text, source_coordinate, grade
      ) VALUES (
        ${claimId}, ${projectId}, 'mining_right', 'MN-1', '{"page":"1"}'::jsonb,
        'verified'
      )
    `;
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_attestations (
        id, case_id, assignment_id, credential_id, schema_id,
        attestation_type, claim_scope, evidence_snapshot_hash, findings, limitations,
        credential_status_snapshot, method_version, policy_version,
        payload_hash, signature, signer_wallet_address, signed_at, state
      ) VALUES (
        ${id}, ${caseId}, ${assignmentId}, ${fx.credentialA}, ${fx.schemaA},
        'professional_signoff', ARRAY[${claimId}]::UUID[], ${`0x${"22".repeat(32)}`},
        '{"note":"reviewed"}'::jsonb, 'legal_effect_not_determined', '{}'::jsonb, '1', '1',
        ${`0x${"33".repeat(32)}`}, ${`0x${"44".repeat(65)}`},
        ${fx.reviewerA.address.toLowerCase()}, now(), ${state}
      )
    `;
    return id;
  }

  describe("two steps, two people (02 §2.8, 07 §7.2)", () => {
    function reject(token: string, drafted: { id: string; version: number }) {
      return app.inject({
        method: "POST",
        url: `/api/v1/registry-entries/drafts/${drafted.id}/reject`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${drafted.version}"`,
        },
        payload: { reason: "The projection names the wrong reviewer organization" },
      });
    }

    it("a draft is not public and is not a registry version", async () => {
      const publicKey = `DRF-${randomUUID().slice(0, 8)}`;
      const drafted = await draft(tokens.operatorA, { publicKey });
      expect(drafted.statusCode).toBe(200);
      expect(drafted.json().state).toBe("pending");

      const lookup = await app.inject({
        method: "GET",
        url: `/api/v1/public/registries/project/${publicKey}`,
      });
      expect(lookup.statusCode).toBe(404);
      const versions = await fx.sql`
        SELECT v.id FROM core.registry_entry_versions v
        JOIN core.registry_entries e ON e.id = v.entry_id
        WHERE e.public_key = ${publicKey}
      `;
      expect(versions).toHaveLength(0);
    });

    it("enforces project scope before publish/reject and cached decision replay", async () => {
      const scoped = await signIn(app, await addGovernanceAccount(fx, "reviewer", { assurance: "high_assurance", scopeKind: "organization" }));
      for (const action of ["publish", "reject"] as const) {
        const projectId=randomUUID(), publicKey=`SCOPE-${projectId}`;
        await fx.sql`INSERT INTO core.projects(id,project_key,name,host_country_iso3,minerals,owner_organization_id)
          VALUES(${projectId},${publicKey},'Other organization','MNG',ARRAY['copper'],${fx.reviewOrgA})`;
        const drafted=await draft(tokens.operatorA,{subjectId:projectId,publicKey});
        expect(drafted.statusCode,drafted.body).toBe(200);
        const hidden=await app.inject({method:"GET",url:`/api/v1/registry-entries/drafts?subjectId=${projectId}`,headers:{authorization:`Bearer ${scoped}`}});
        expect(hidden.statusCode,hidden.body).toBe(200);
        expect(hidden.json().items).toEqual([]);
        const key=idempotencyKey();
        const decide=(token:string)=>app.inject({method:"POST",url:`/api/v1/registry-entries/drafts/${drafted.json().id}/${action}`,
          headers:{authorization:`Bearer ${token}`,"idempotency-key":key,"if-match":`"${drafted.json().version}"`},
          payload:action==="publish"?{irreversibilityAcknowledged:true}:{reason:"Independent rejection"}});
        expect((await decide(scoped)).statusCode).toBe(403);
        const allowed=await decide(tokens.disclosureApproverA);
        expect(allowed.statusCode,allowed.body).toBe(200);
        expect((await decide(scoped)).statusCode).toBe(403);
        expect((await decide(tokens.disclosureApproverA)).statusCode).toBe(200);
      }
      const own=await draft(tokens.operatorA);
      const allowed=await publishDraft(app,scoped,own.json());
      expect(allowed.statusCode,allowed.body).toBe(200);
    });

    it("keeps scoped administrators inside their projects and out of Registry anchor operations", async () => {
      const scoped=await signIn(app,await addGovernanceAccount(fx,"administrator",{assurance:"high_assurance",scopeKind:"organization"}));
      const foreign=randomUUID(), publicKey=`ADMIN-SCOPE-${foreign}`;
      await fx.sql`INSERT INTO core.projects(id,project_key,name,host_country_iso3,minerals,owner_organization_id)
        VALUES(${foreign},${publicKey},'Other organization','MNG',ARRAY['copper'],${fx.reviewOrgA})`;
      const payload={registryType:"project",subjectId:foreign,publicKey,projection:await projectProjection(fx.sql,foreign),policyVersion:"mn-core-1.0.0",schemaVersion:"project-registry-1"};
      const draftKey=idempotencyKey();
      const create=(token:string)=>app.inject({method:"POST",url:"/api/v1/registry-entries",headers:{authorization:`Bearer ${token}`,"idempotency-key":draftKey},payload});
      expect((await create(scoped)).statusCode).toBe(403);
      const allowedDraft=await create(tokens.operatorA);
      expect(allowedDraft.statusCode,allowedDraft.body).toBe(200);
      expect((await create(scoped)).statusCode).toBe(403);
      const publishedResponse=await publishDraft(app,tokens.disclosureApproverA,allowedDraft.json());
      expect(publishedResponse.statusCode,publishedResponse.body).toBe(200);
      const published=publishedResponse.json(), revokeKey=idempotencyKey();
      const revoke=(token:string)=>app.inject({method:"POST",url:`/api/v1/registry-entries/${published.entryId}/revoke`,headers:{authorization:`Bearer ${token}`,"idempotency-key":revokeKey,"if-match":`"${published.version}"`},payload:{reasonCode:"SOURCE_CORRECTION"}});
      expect((await revoke(scoped)).statusCode).toBe(403);
      expect((await revoke(tokens.operatorA)).statusCode).toBe(200);
      expect((await revoke(scoped)).statusCode).toBe(403);
      expect((await revoke(tokens.operatorA)).statusCode).toBe(200);
      const ownDraft=await draft(scoped);
      expect(ownDraft.statusCode,ownDraft.body).toBe(200);
      const ownPublished=await publishDraft(app,tokens.disclosureApproverA,ownDraft.json());
      expect(ownPublished.statusCode,ownPublished.body).toBe(200);
      const ownRevoke=await app.inject({method:"POST",url:`/api/v1/registry-entries/${ownPublished.json().entryId}/revoke`,headers:{authorization:`Bearer ${scoped}`,"idempotency-key":idempotencyKey(),"if-match":`"${ownPublished.json().version}"`},payload:{reasonCode:"SOURCE_CORRECTION"}});
      expect(ownRevoke.statusCode,ownRevoke.body).toBe(200);
      for(const [project,target,expected] of [[foreign,published.id,403],[ownDraft.json().subjectId,ownPublished.json().id,200]] as const){
        const signal=randomUUID();
        await fx.sql`INSERT INTO core.evidence_stale_signals(id,project_id,target_type,target_id,reason)
          VALUES(${signal},${project},'registry_entry_version',${target},'Synthetic scope regression')`;
        const result=await app.inject({method:"POST",url:`/api/v1/stale-signals/${signal}/resolve`,headers:{authorization:`Bearer ${scoped}`,"idempotency-key":idempotencyKey()},payload:{resolution:"dismissed",note:"Scope checked"}});
        expect(result.statusCode,result.body).toBe(expected);
      }
      for(const [method,url] of [["POST",`/api/v1/anchor-batches/${randomUUID()}/resubmit`],["GET","/api/v1/anchor-batches"]] as const){
        const result=await app.inject({method,url,headers:{authorization:`Bearer ${scoped}`,"idempotency-key":idempotencyKey()}});
        expect(result.statusCode,result.body).toBe(403);
      }
    });

    const administratorCopy = {
      limitations: PROJECT_PUBLICATION_LIMITATIONS,
      disclaimerCodes: PROJECT_PUBLICATION_DISCLAIMERS,
    };

    async function withPublishingSession<T>(
      token: string,
      subjectId: string,
      work: (tx: postgres.TransactionSql) => Promise<T>,
    ): Promise<T> {
      const [session] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.sessions WHERE token_hash = ${hashToken(token)}
      `;
      expect(session?.id).toBeTruthy();
      return withActor(fx.appSql, { subjectId }, async (tx) => {
        await tx`SELECT set_config('app.registry_publication_session_id', ${session!.id}, true)`;
        return work(tx);
      });
    }

    const submitDisclosureApproval = (token: string, target: { id: string; version: number }) => app.inject({
      method: "POST", url: `/api/v1/registry-entries/drafts/${target.id}/approve-disclosure`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey(), "if-match": `"${target.version}"` },
      payload: { disclosureReviewed: true },
    });

    it("publishes an eligible draft after an optional reviewer approval becomes historical", async () => {
      const projectId = await projectWithKey(`SUSPENDED-DISCLOSURE-${randomUUID()}`);
      const reviewer = await addGovernanceAccount(fx, "reviewer", { projectId, assurance: "high_assurance" });
      const [holder] = await fx.sql<{ subject_id: string }[]>`
        SELECT subject_id FROM core.wallet_identities WHERE wallet_address = ${reviewer.address}
      `;
      const reviewerId = holder!.subject_id;
      const prepared = await draft(tokens.operatorA, {
        subjectId: projectId, prepareAdministratorPublication: true,
        projection: await projectProjection(fx.sql, projectId, administratorCopy),
      });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const reviewerToken = await signIn(app, reviewer);
      const secondAdmin = await addGovernanceAccount(fx, "administrator", {
        scopeKind: "registry", assurance: "high_assurance",
      });
      const secondAdminToken = await signIn(app, secondAdmin);
      const [decider] = await fx.sql<{ subject_id: string }[]>`
        SELECT subject_id FROM core.wallet_identities WHERE wallet_address = ${secondAdmin.address}
      `;

      async function propose(action: "suspend" | "reinstate") {
        const proposed = await app.inject({
          method: "POST", url: "/api/v1/admin/subject-suspensions",
          headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
          payload: { subjectId: reviewerId, action, reason: "Disclosure approval regression" },
        });
        expect(proposed.statusCode, proposed.body).toBe(200);
        return proposed.json<{ id: string; version: number }>();
      }

      const suspension = await propose("suspend");
      // Start the suspension transaction first, then commit the review before it locks the reviewer.
      const pending = await withActor(fx.appSql, { subjectId: decider!.subject_id }, async (tx) => {
        const approval = await submitDisclosureApproval(reviewerToken, prepared.json());
        expect(approval.statusCode, approval.body).toBe(200);
        expect(approval.json()).toMatchObject({
          disclosureApproved: true,
          state: "pending",
          version: prepared.json().version + 1,
          projection: prepared.json().projection,
        });
        await tx`
          SELECT * FROM core.decide_subject_suspension(
            ${suspension.id}, ${decider!.subject_id}, true, 'Independent suspension decision', ${suspension.version}
          )
        `;
        return approval.json();
      });
      const [ordering] = await fx.sql`
        SELECT s.decided_at < d.disclosure_approved_at AS suspension_clock_started_first
        FROM core.subject_suspensions s CROSS JOIN core.registry_publication_drafts d
        WHERE s.id = ${suspension.id} AND d.id = ${pending.id}
      `;
      expect(ordering?.suspension_clock_started_first).toBe(true);

      const { id, version } = await propose("reinstate");
      const decided = await app.inject({
        method: "POST", url: `/api/v1/admin/subject-suspensions/${id}/decision`,
        headers: { authorization: `Bearer ${secondAdminToken}`, "idempotency-key": idempotencyKey(), "if-match": `"${version}"` },
        payload: { decision: "approve", reason: "Independent reinstatement decision" },
      });
      expect(decided.statusCode, decided.body).toBe(200);

      const result = await publishDraft(app, tokens.operatorA, pending);
      expect(result.statusCode, result.body).toBe(200);
      const [historical] = await fx.sql`
        SELECT disclosure_approved_by_subject_id FROM core.registry_publication_drafts WHERE id = ${pending.id}
      `;
      expect(historical?.disclosure_approved_by_subject_id).toBe(reviewerId);
      const [approvalEvent] = await fx.sql`
        SELECT project_id FROM audit.events
        WHERE resource_id = ${pending.id} AND command = 'registry.version.draft_disclosure_approved'
      `;
      expect(approvalEvent?.project_id).toBe(projectId);
    });

    it("lists drafts only in the administrator's jurisdiction", async () => {
      const inScope = await draft(tokens.operatorA);
      const projectId = await projectWithKey(`DRAFT-OUTSIDE-${randomUUID()}`);
      await fx.sql`UPDATE core.projects SET host_country_iso3 = 'KOR' WHERE id = ${projectId}`;
      const outside = await draft(tokens.operatorA, { subjectId: projectId });
      expect(inScope.statusCode, inScope.body).toBe(200);
      expect(outside.statusCode, outside.body).toBe(200);

      const token = await signIn(app, await addGovernanceAccount(fx, "administrator", {
        scopeKind: "registry", jurisdiction: ["MNG"], assurance: "high_assurance",
      }));
      const response = await app.inject({
        method: "GET", url: "/api/v1/registry-entries/drafts",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      const ids = response.json().items.map((item: { id: string }) => item.id);
      expect(ids).toContain(inScope.json().id);
      expect(ids).not.toContain(outside.json().id);
    });

    it("replays legacy draft creation and discard responses with the preparation flag", async () => {
      const projectId = await projectWithKey(`DRAFT-REPLAY-${randomUUID()}`);
      const [project] = await fx.sql`SELECT project_key FROM core.projects WHERE id = ${projectId}`;
      const createKey = idempotencyKey();
      const projection = await projectProjection(fx.sql, projectId);
      const create = () => draftRegistryEntry(app, tokens.operatorA, {
        registryType: "project", subjectId: projectId, publicKey: project!.project_key,
        policyVersion: "1", schemaVersion: "1", projection,
      }, createKey);
      const prepared = await create();
      expect(prepared.statusCode, prepared.body).toBe(200);
      const row = prepared.json();
      const discardKey = idempotencyKey();
      const discard = () => app.inject({
        method: "POST", url: `/api/v1/registry-entries/drafts/${row.id}/reject`,
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": discardKey, "if-match": `"${row.version}"` },
        payload: { reason: "Discard" },
      });
      const rejected = await discard();
      expect(rejected.statusCode, rejected.body).toBe(200);

      await fx.sql`UPDATE core.idempotency_keys
        SET response_snapshot = response_snapshot - 'administratorPublicationPrepared' - 'disclosureApproved'
        WHERE key IN (${createKey}, ${discardKey})`;
      for (const [replay, expected] of [[await create(), row], [await discard(), rejected.json()]] as const) {
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toEqual(expected);
      }
    });

    it("attributes an own draft discard to the administrator grant when both roles apply", async () => {
      const projectId = await projectWithKey(`ADMIN-DISCARD-ROLE-${randomUUID()}`);
      const account = await addGovernanceAccount(fx, "reviewer", { projectId, assurance: "high_assurance" });
      const [holder] = await fx.sql<{ subject_id: string }[]>`SELECT subject_id
        FROM core.wallet_identities WHERE wallet_address = ${account.address}`;
      await fx.sql`INSERT INTO core.role_bindings(id, subject_id, organization_id, project_id, role)
        VALUES (${randomUUID()}, ${holder!.subject_id}, ${fx.orgA}, ${projectId}, 'administrator')`;
      const token = await signIn(app, account);
      const prepared = await draft(token, { subjectId: projectId });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const own = prepared.json();
      const response = await app.inject({
        method: "POST", url: `/api/v1/registry-entries/drafts/${own.id}/reject`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey(), "if-match": `"${own.version}"` },
        payload: { reason: "Discard own draft" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const [event] = await fx.sql`SELECT effective_role FROM audit.events
        WHERE command = 'registry.version.draft_rejected' AND resource_id = ${own.id}`;
      expect(event?.effective_role).toBe("administrator");
    });

    it("an administrator can discard a stale own draft and replace it", async () => {
      const projectId = await projectWithKey(`ADMIN-STALE-${randomUUID()}`);
      const prepared = await draft(tokens.operatorA, {
        subjectId: projectId, prepareAdministratorPublication: true, projection: await projectProjection(fx.sql, projectId, administratorCopy),
      });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const original = prepared.json();
      await fx.sql`UPDATE core.projects SET version = version + 1 WHERE id = ${projectId}`;
      const stale = await publishDraft(app, tokens.operatorA, original);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().code).toBe("REGISTRY_DRAFT_STALE");

      const discard = async (token: string) => app.inject({
        method: "POST", url: `/api/v1/registry-entries/drafts/${original.id}/reject`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey(), "if-match": `"${original.version}"` },
        payload: { reason: "Replace stale draft" },
      });
      const otherAdmin = await signIn(app, await addGovernanceAccount(fx, "administrator", {
        projectId, assurance: "high_assurance",
      }));
      expect((await discard(otherAdmin)).statusCode).toBe(403);
      expect((await discard(tokens.operatorA)).json()).toMatchObject({ state: "rejected" });
      const replacement = await draft(tokens.operatorA, {
        subjectId: projectId, prepareAdministratorPublication: true, projection: await projectProjection(fx.sql, projectId, administratorCopy),
      });
      expect(replacement.statusCode, replacement.body).toBe(200);
      const published = await publishDraft(app, tokens.operatorA, replacement.json());
      expect(published.statusCode, published.body).toBe(200);
    });

    it.each(["identifier", "free text", "verification"] as const)(
      "requires independent review for own %s drafts", async (kind) => {
        const projectId = await projectWithKey(`ADMIN-REVIEW-${randomUUID()}`);
        const attestationId = kind === "verification" ? await seedAttestation(projectId, "signed") : null;
        const prepared = attestationId
          ? await draftRegistryEntry(app, tokens.operatorA, {
              registryType: "verification", subjectId: attestationId, publicKey: `VER-${randomUUID()}`,
              projection: validProjection({ stableId: attestationId, status: "signed" }),
              policyVersion: "mn-core-1.0.0", schemaVersion: "verification-registry-1",
            })
          : await draft(tokens.operatorA, {
              subjectId: projectId,
              projection: await projectProjection(fx.sql, projectId, {
                ...administratorCopy,
                ...(kind === "free text" ? { claimSummary: [{ summary: "Requires review" }] } : {}),
              }),
              ...(kind === "identifier" ? {
                containsPersonLevelIdentifier: true,
                personIdentifierRecord: {
                  lawfulBasis: "Legal obligation", purpose: "Disclosure", retention: "Seven years",
                  irreversibilityAcknowledged: true,
                },
              } : {}),
            });
        expect(prepared.statusCode, prepared.body).toBe(200);
        const response = await publishDraft(app, tokens.operatorA, prepared.json(), {
          personIdentifierPublicationApproved: true,
        });
        expect(response.statusCode, response.body).toBe(422);
        expect(response.json().code).toBe("REGISTRY_DRAFT_SELF_PUBLICATION");
        if (kind !== "verification") {
          const version = await publish(tokens.operatorA);
          expect(version.statusCode, version.body).toBe(200);
          await expect(withPublishingSession(tokens.operatorA, fx.operatorSubjectA, (tx) => tx`
            UPDATE core.registry_publication_drafts
            SET state = 'published', decided_by_subject_id = proposed_by_subject_id,
                decided_at = now(), entry_version_id = ${version.json().id},
                person_identifier_publication_approved = ${kind === "identifier"}
            WHERE id = ${prepared.json().id}
          `)).rejects.toMatchObject({ code: "23514", constraint_name: "registry_draft_two_person" });
        }
      },
    );

    it.each(["revoked", "suspended", "lower identity assurance", "foreign organization", "foreign jurisdiction"] as const)(
      "refuses self-publication after the administrator becomes %s", async (change) => {
        const projectId = await projectWithKey(`ADMIN-SCOPE-${randomUUID()}`);
        const wallet = await addGovernanceAccount(fx, "administrator", {
          scopeKind: "organization", jurisdiction: ["MNG"], assurance: "high_assurance",
        });
        const token = await signIn(app, wallet);
        const prepared = await draft(token, {
          subjectId: projectId, prepareAdministratorPublication: true, projection: await projectProjection(fx.sql, projectId, administratorCopy),
        });
        expect(prepared.statusCode, prepared.body).toBe(200);
        const pending = prepared.json();
        const subjectId = pending.proposedBySubjectId as string;
        const other = await publish(tokens.operatorA);
        expect(other.statusCode, other.body).toBe(200);

        switch (change) {
          case "revoked":
            await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${subjectId}`;
            break;
          case "suspended":
            await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${subjectId}`;
            break;
          case "lower identity assurance":
            await fx.sql`UPDATE core.subjects SET assurance_level = 'identity_bound' WHERE id = ${subjectId}`;
            break;
          case "foreign organization":
            await fx.sql`UPDATE core.projects SET owner_organization_id = ${fx.orgB} WHERE id = ${projectId}`;
            break;
          case "foreign jurisdiction":
            await fx.sql`UPDATE core.projects SET host_country_iso3 = 'KOR' WHERE id = ${projectId}`;
            break;
        }

        const response = await publishDraft(app, token, pending);
        expect(response.statusCode, response.body).toBe(change === "suspended" ? 401 : 403);
        if (change !== "suspended") {
          await expect(withPublishingSession(token, subjectId, (tx) => tx`
            UPDATE core.registry_publication_drafts
            SET state = 'published', decided_by_subject_id = proposed_by_subject_id,
                decided_at = now(), entry_version_id = ${other.json().id}
            WHERE id = ${pending.id}
          `)).rejects.toMatchObject({ code: "23514", constraint_name: "registry_draft_two_person" });
        }
      },
    );

    it("keeps the database projection allowlist and fixed copy aligned with the contract", async () => {
      const [guard] = await fx.sql<{ source: string }[]>`
        SELECT pg_get_functiondef('core.guard_registry_draft_self_publication()'::regprocedure) AS source
      `;
      const guardSource = guard!.source;
      const keys = /NEW\.projection - ARRAY\[([^\]]+)\]/.exec(guardSource)?.[1];
      expect(Array.from(keys?.matchAll(/'([^']+)'/g) ?? [], (match) => match[1]).sort())
        .toEqual(Object.keys(administratorProjectProjection.shape).sort());
      for (const [field, expected] of [
        ["limitations", PROJECT_PUBLICATION_LIMITATIONS],
        ["disclaimerCodes", PROJECT_PUBLICATION_DISCLAIMERS],
      ] as const) {
        const literal = new RegExp(`NEW\\.projection->'${field}' = '([^']+)'`).exec(guardSource)?.[1];
        expect(JSON.parse(literal ?? "null")).toEqual(expected);
      }
    });

    it("preserves submitted metadata when a draft is prepared for independent review", async () => {
      const projectId = await projectWithKey(`REVIEWER-PROJECTION-${randomUUID()}`);
      const projection = await projectProjection(fx.sql, projectId, administratorCopy);
      const prepared = await draft(tokens.operatorA, { subjectId: projectId, projection });
      expect(prepared.statusCode, prepared.body).toBe(200);
      expect(prepared.json()).toMatchObject({ administratorPublicationPrepared: false, projection });
      const publication = await publishDraft(app, tokens.disclosureApproverA, prepared.json());
      expect(publication.statusCode, publication.body).toBe(200);
      const [entry] = await fx.sql`SELECT public_projection FROM core.registry_entry_versions WHERE id = ${publication.json().id}`;
      expect(entry?.public_projection).toMatchObject({ asOf: projection.asOf, sourceAge: "12", staleStatus: "fresh" });
    });

    it("a project-scoped administrator can draft, publish and create an anchor batch", async () => {
      const [runtime] = await fx.appSql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(runtime).toEqual({ rolsuper: false, rolbypassrls: false });
      const projectId = await projectWithKey(`ADMIN-PUBLISH-${randomUUID()}`);
      const [internal] = await fx.sql`
        UPDATE core.projects SET name = 'Internal project name', minerals = ARRAY['Internal mineral text']
        WHERE id = ${projectId} RETURNING project_key
      `;
      const admin = await signIn(app, await addGovernanceAccount(fx, "administrator", {
        projectId, assurance: "high_assurance",
      }));
      const prepared = await draft(admin, {
        subjectId: projectId, prepareAdministratorPublication: true, projection: await projectProjection(fx.sql, projectId, {
          ...administratorCopy, projectName: "Internal project name", mineral: ["Internal mineral text"],
          projectKey: internal!.project_key, version: "999", sourceAge: "0", asOf: "2099-01-01T00:00:00.000Z",
        }),
        policyVersion: "Internal policy text", schemaVersion: "Internal schema text",
      });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const draftRow = prepared.json();
      expect(draftRow).toMatchObject({
        disclosureApproved: false, publicKey: `PRJ-${projectId}`, policyVersion: "1.0.0", schemaVersion: "1",
      });
      for (const privateField of ["projectName", "projectKey", "mineral", "evidenceLedger"]) {
        expect(draftRow.projection).not.toHaveProperty(privateField);
      }
      expect((await submitDisclosureApproval(admin, draftRow)).statusCode).toBe(403);
      await expect(withPublishingSession(admin, draftRow.proposedBySubjectId, (tx) => tx`
        UPDATE core.registry_publication_drafts
        SET disclosure_approved_by_subject_id = proposed_by_subject_id, version = version + 1
        WHERE id = ${draftRow.id}
      `)).rejects.toMatchObject({ code: "23514", constraint_name: "registry_draft_disclosure_approval_authority" });
      const published = await publishDraft(app, admin, draftRow);
      expect(published.statusCode, published.body).toBe(200);
      const [entry] = await fx.sql`SELECT public_projection FROM core.registry_entry_versions WHERE id = ${published.json().id}`;
      expect(draftRow.projection).toMatchObject({
        version: "1", sourceAge: null, staleStatus: "unknown", asOf: draftRow.proposedAt,
      });
      expect(entry?.public_projection).toMatchObject(draftRow.projection);
      const publicResponse = await app.inject({
        method: "GET", url: `/api/v1/public/registries/project/${draftRow.publicKey}`,
      });
      expect(publicResponse.statusCode, publicResponse.body).toBe(200);
      expect(publicResponse.json()).toMatchObject({ stableId: projectId, hostCountry: "MNG" });
      expect(publicResponse.body).not.toContain("Internal");
      expect(publicResponse.json()).not.toHaveProperty("projectKey");
      expect(new Date(draftRow.proposedAt).getTime()).toBeLessThanOrEqual(Date.now());
      const [audit] = await fx.sql`SELECT detail FROM audit.events
        WHERE resource_id = ${published.json().id} AND command = 'registry.version.published'`;
      expect(audit?.detail).toMatchObject({ selfPublished: true });
      const [decision] = await fx.sql`SELECT proposed_by_subject_id, decided_by_subject_id
        FROM core.registry_publication_drafts WHERE id = ${draftRow.id}`;
      expect(decision?.decided_by_subject_id).toBe(decision?.proposed_by_subject_id);
      const batch = await app.inject({
        method: "POST", url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${admin}`, "idempotency-key": idempotencyKey() },
        payload: { projectId },
      });
      expect(batch.statusCode, batch.body).toBe(200);
      expect(batch.json()).toMatchObject({ recordCount: 1, confirmationState: "created" });

      const reviewed = await draft(admin, {
        subjectId: projectId, projection: await projectProjection(fx.sql, projectId),
      });
      expect(reviewed.statusCode, reviewed.body).toBe(200);
      expect(reviewed.json().publicKey).toBe(draftRow.publicKey);
      const reviewedVersion = await publishDraft(app, tokens.disclosureApproverA, reviewed.json());
      expect(reviewedVersion.statusCode, reviewedVersion.body).toBe(200);
      expect(reviewedVersion.json()).toMatchObject({ entryId: published.json().entryId, version: 2 });
    });

    it("an administrator cannot publish a draft by another person without reviewer authority", async () => {
      const projectId = await projectWithKey(`ADMIN-OTHER-${randomUUID()}`);
      const prepared = await draft(tokens.operatorA, { subjectId: projectId });
      expect(prepared.statusCode, prepared.body).toBe(200);
      const otherAdmin = await signIn(app, await addGovernanceAccount(fx, "administrator", {
        projectId, assurance: "high_assurance",
      }));
      const target = prepared.json();
      for (const version of [target.version, target.version + 1]) {
        const response = await publishDraft(app, otherAdmin, { id: target.id, version });
        expect(response.statusCode).toBe(403);
        expect(response.json().details.requiredRoles).toEqual(["reviewer"]);
      }
    });

    it.each(["origin", "replica"] as const)("the database rejects unauthenticated self-publication in %s mode", async (mode) => {
      const drafted = (await draft(tokens.operatorA)).json();
      const published = (await publish(tokens.operatorA)).json();
      await expect(
        fx.sql.begin(async (tx) => {
          await tx`SELECT set_config('session_replication_role', ${mode}, true)`;
          return tx`
          UPDATE core.registry_publication_drafts
          SET state = 'published', decided_by_subject_id = proposed_by_subject_id,
              decided_at = now(), entry_version_id = ${published.id}
          WHERE id = ${drafted.id}
          `;
        }),
      ).rejects.toMatchObject({ code: "23514", constraint_name: "registry_draft_two_person" });
    });

    it("a draft cannot be edited after it is made", async () => {
      // The approver approves what they read. An edit after drafting would publish something
      // nobody approved.
      const drafted = (await draft(tokens.operatorA)).json();
      await expect(
        fx.sql`
          UPDATE core.registry_publication_drafts
          SET projection = '{"stableId":"changed"}'::jsonb
          WHERE id = ${drafted.id}
        `,
      ).rejects.toThrow(/cannot be modified after it is created/);
    });

    // A Project Registry entry is published under its project's key, and project keys are unique
    // across the Registry, so two companies cannot draft or hold the same project key; the
    // project-creation conflict is covered in projects.test.ts.

    it("a rejected draft publishes nothing and frees the key for a new draft", async () => {
      const publicKey = `REJ-${randomUUID().slice(0, 8)}`;
      const drafted = (await draft(tokens.operatorA, { publicKey })).json();

      const second = await draft(tokens.operatorA, { publicKey });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("REGISTRY_DRAFT_PENDING");

      const rejected = await reject(tokens.disclosureApproverA, drafted);
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().state).toBe("rejected");

      const again = await publishDraft(app, tokens.disclosureApproverA, drafted);
      expect(again.statusCode).toBe(412);

      expect((await draft(tokens.operatorA, { publicKey })).statusCode).toBe(200);
    });

    it("a draft made stale by new evidence cannot be published", async () => {
      const publicKey = `STL-${randomUUID().slice(0, 8)}`;
      const drafted = (await draft(tokens.operatorA, { publicKey })).json();

      await fx.sql`
        INSERT INTO core.claims (
          id, project_id, claim_type, value_text, source_coordinate
        ) VALUES (
          ${randomUUID()}, ${projectsByKey.get(publicKey)!}, 'mining_right',
          'MN-2', '{"page":"2"}'::jsonb
        )
      `;

      const response = await publishDraft(app, tokens.disclosureApproverA, drafted);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("REGISTRY_DRAFT_STALE");
      expect(response.json().details.staleFields).toContain("sourceSnapshotHash");
    });
  });

  describe("what the server derives (05 §5.6·§5.12)", () => {
    it("refuses the asset registry before R6", async () => {
      const response = await draft(tokens.operatorA, { registryType: "asset" });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("REGISTRY_TYPE_NOT_AVAILABLE");
    });

    it("records the server's evidence snapshot hash, not the client's", async () => {
      const claimed = await draft(tokens.operatorA, { sourceSnapshotHash: `0x${"11".repeat(32)}` });
      expect(claimed.statusCode).toBe(422);
      expect(claimed.json().code).toBe("REGISTRY_SNAPSHOT_MISMATCH");

      const expected = claimed.json().details.expected as string;
      const drafted = await draft(tokens.operatorA);
      expect(drafted.json().sourceSnapshotHash).toMatch(/^0x[0-9a-f]{64}$/);

      const published = (await publishDraft(app, tokens.disclosureApproverA, drafted.json())).json();
      const [row] = await fx.sql<{ source_snapshot_hash: string }[]>`
        SELECT source_snapshot_hash FROM core.registry_entry_versions WHERE id = ${published.id}
      `;
      expect(row!.source_snapshot_hash).toBe(drafted.json().sourceSnapshotHash);
      // Two empty projects have the same evidence set, so the same hash.
      expect(expected).toBe(drafted.json().sourceSnapshotHash);
    });

    it("rejects a projection that disagrees with the project", async () => {
      const projectId = await projectWithKey(`MIS-${randomUUID().slice(0, 8)}`);
      const response = await draft(tokens.operatorA, {
        subjectId: projectId,
        projection: await projectProjection(fx.sql, projectId, {
          projectName: "Someone else's mine",
          status: "offering",
        }),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("PUBLICATION_PROJECTION_MISMATCH");
      expect(response.json().details.offendingFields).toEqual(["projectName", "status"]);
    });

    it("publishes a project entry only under the project's key", async () => {
      const projectId = await projectWithKey(`OWN-${randomUUID().slice(0, 8)}`);
      const response = await draft(tokens.operatorA, {
        subjectId: projectId,
        publicKey: `OTHER-${randomUUID().slice(0, 8)}`,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("REGISTRY_PUBLIC_KEY_MISMATCH");
    });

    it("a verification entry must point to a signed attestation", async () => {
      const projectId = await projectWithKey(`VRF-${randomUUID().slice(0, 8)}`);
      const pointsAtProject = await draftRegistryEntry(app, tokens.operatorA, {
        registryType: "verification",
        subjectId: projectId,
        publicKey: `VER-${randomUUID().slice(0, 8)}`,
        projection: validProjection({ stableId: projectId, status: "signed" }),
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "verification-registry-1",
      });
      expect(pointsAtProject.statusCode).toBe(422);
      expect(pointsAtProject.json().code).toBe("REGISTRY_SUBJECT_NOT_SIGNED");

      const revoked = await seedAttestation(projectId, "revoked");
      const pointsAtRevoked = await draftRegistryEntry(app, tokens.operatorA, {
        registryType: "verification",
        subjectId: revoked,
        publicKey: `VER-${randomUUID().slice(0, 8)}`,
        projection: validProjection({ stableId: revoked, status: "revoked" }),
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "verification-registry-1",
      });
      expect(pointsAtRevoked.statusCode).toBe(422);
      expect(pointsAtRevoked.json().code).toBe("REGISTRY_SUBJECT_NOT_SIGNED");
    });

    it("a blackout on the project blocks a verification entry too", async () => {
      const projectId = await projectWithKey(`VBO-${randomUUID().slice(0, 8)}`);
      const attestationId = await seedAttestation(projectId, "signed");
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/disclosure-restrictions`,
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {
          subjectScope: [projectId],
          restrictedActionTypes: ["registry.publish"],
          materialInfoRef: "board-minutes-2026-10",
          reason: "Resource estimate revision pending disclosure",
          legalBasis: "Listing rule 3.1",
          authority: "Disclosure committee",
          expectedNextUpdateAt: "2026-11-01T00:00:00.000Z",
        },
      });
      expect(created.statusCode).toBe(201);
      const activated = await app.inject({
        method: "POST",
        url: `/api/v1/disclosure-restrictions/${created.json().restrictionId}/activate`,
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${created.json().version}"`,
        },
        payload: { reason: "Material information identified" },
      });
      expect(activated.statusCode).toBe(200);

      const drafted = await draftRegistryEntry(app, tokens.operatorA, {
        registryType: "verification",
        subjectId: attestationId,
        publicKey: `VER-${randomUUID().slice(0, 8)}`,
        projection: validProjection({ stableId: attestationId, status: "signed" }),
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "verification-registry-1",
      });
      expect(drafted.statusCode).toBe(200);
      const published = await publishDraft(app, tokens.disclosureApproverA, drafted.json());
      expect(published.statusCode).toBe(409);
      expect(published.json().code).toBe("DISCLOSURE_RESTRICTED");
    });

    it("a verification entry records the attestation's signed snapshot", async () => {
      const projectId = await projectWithKey(`VSN-${randomUUID().slice(0, 8)}`);
      const attestationId = await seedAttestation(projectId, "signed");
      const drafted = await draftRegistryEntry(app, tokens.operatorA, {
        registryType: "verification",
        subjectId: attestationId,
        publicKey: `VER-${randomUUID().slice(0, 8)}`,
        projection: validProjection({ stableId: attestationId, status: "signed" }),
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "verification-registry-1",
      });
      expect(drafted.statusCode).toBe(200);
      expect(drafted.json().sourceSnapshotHash).toBe(`0x${"22".repeat(32)}`);
      // The signed claim has no receipt behind it, so its terms are unknown.
      expect(drafted.json().commercialReuse).toBe("unconfirmed");
    });
  });

  it("rejects a projection without limitations", async () => {
    const projection = validProjection();
    delete (projection as Record<string, unknown>)["limitations"];
    const response = await publish(tokens.operatorA, { projection });
    expect(response.statusCode).toBe(422);
  });

  it("cannot overwrite a published projection", async () => {
    const published = (await publish(tokens.operatorA)).json();
    await expect(
      fx.sql`
        UPDATE core.registry_entry_versions
        SET public_projection = '{"stableId":"changed"}'::jsonb
        WHERE id = ${published.id}
      `,
    ).rejects.toThrow(/cannot be overwritten/);
  });

  it("a new version links the previous one as superseded — does not delete it", async () => {
    const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
    const first = (await publish(tokens.operatorA, { publicKey })).json();
    const second = (await publish(tokens.operatorA, { publicKey })).json();

    expect(second.version).toBe(2);

    const [previous] = await fx.sql<{ status: string; superseded_by_id: string }[]>`
      SELECT status, superseded_by_id FROM core.registry_entry_versions WHERE id = ${first.id}
    `;
    expect(previous!.status).toBe("superseded");
    expect(previous!.superseded_by_id).toBe(second.id);
  });

  it("revoke is a new state, not a deletion", async () => {
    const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
    const published = (await publish(tokens.operatorA, { publicKey })).json();

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/registry-entries/${published.entryId}/revoke`,
      headers: {
        authorization: `Bearer ${tokens.operatorA}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${published.version}"`,
      },
      payload: { reasonCode: "SOURCE_CORRECTION" },
    });
    expect(revoked.statusCode).toBe(200);

    const [row] = await fx.sql<{ status: string; public_projection: unknown }[]>`
      SELECT status, public_projection FROM core.registry_entry_versions WHERE id = ${published.id}
    `;
    expect(row!.status).toBe("revoked");
    expect(row!.public_projection).not.toBeNull();
  });

  describe("resubmitting a stuck batch", () => {
    async function makeBatch() {
      const publicKey = `RESUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });
      const batch = await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: { projectId: await projectWithKey(publicKey) },
      });
      return batch.json().id as string;
    }

    function resubmit(batchId: string) {
      return app.inject({
        method: "POST",
        url: `/api/v1/anchor-batches/${batchId}/resubmit`,
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: {},
      });
    }

    it("does not resubmit an in-progress batch", async () => {
      const batchId = await makeBatch();

      // Resetting created/submitted/included would forget a transaction already on chain
      // and submit the same root again.
      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ANCHOR_NOT_RESUBMITTABLE");
      expect(response.json().details.currentState).toBe("created");
    });

    it.each(["dropped", "reconciliation_required", "failed", "reverted"])("resets attempts and search timers when resubmitting %s", async (previousState) => {
      const batchId = await makeBatch();
      await fx.sql`
        UPDATE chain.transactions
        SET state = ${previousState}, attempts = 3, tx_hash = ${`0x${"ab".repeat(32)}`},
            contract_address = ${`0x${"a1".repeat(20)}`},
            chain_search_failed_since = now() - interval '2 hours', retry_after = now() + interval '1 hour'
        WHERE batch_id = ${batchId}
      `;

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(200);
      expect(response.json().previousState).toBe(previousState);

      const [row] = await fx.sql<
        { state: string; attempts: number; tx_hash: string | null; contract_address: string | null; chain_search_failed_since: Date | null; retry_after: Date | null }[]
      >`
        SELECT state, attempts, tx_hash, contract_address, chain_search_failed_since, retry_after FROM chain.transactions WHERE batch_id = ${batchId}
      `;
      // The contract belonged to the cleared hash; the next send records its own.
      expect(row!.contract_address).toBeNull();
      // A person checked the cause and decided, so it does not inherit the previous attempt cap.
      expect(row!.state).toBe("created");
      expect(row!.attempts).toBe(0);
      expect(row!.tx_hash).toBeNull();
      expect(row!.chain_search_failed_since).toBeNull();
      expect(row!.retry_after).toBeNull();
    });

    it("another company's organization-scoped administrator cannot reset a stuck batch or its retry schedule", async () => {
      const batchId = await makeBatch();
      await fx.sql`UPDATE chain.transactions SET state = 'reconciliation_required',
        chain_search_failed_since = now() - interval '2 hours', retry_after = now() + interval '1 hour'
        WHERE batch_id = ${batchId}`;
      const [before] = await fx.sql`SELECT state, chain_search_failed_since, retry_after FROM chain.transactions WHERE batch_id = ${batchId}`;
      const response = await app.inject({
        method: "POST", url: `/api/v1/anchor-batches/${batchId}/resubmit`,
        headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      const [after] = await fx.sql`SELECT state, chain_search_failed_since, retry_after FROM chain.transactions WHERE batch_id = ${batchId}`;
      expect(after).toEqual(before);
    });

    // The fixture DB is shared across runs, and hashes are unique per chain.
    const randomHash = () => `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;

    /** A batch whose transaction ended `state` on 5611 before this deployment moved to 31337. */
    async function stuckOnOldChain(state = "failed", txHash: string | null = null) {
      const batchId = await makeBatch();
      await fx.sql`
        UPDATE chain.transactions
        SET state = ${state}, attempts = 2, tx_hash = ${txHash}, chain_id = 5611,
            contract_address = ${txHash ? `0x${"5b".repeat(20)}` : null}, last_error = 'submit_failed'
        WHERE batch_id = ${batchId}
      `;
      const [row] = await fx.sql<{ id: string }[]>`
        SELECT id FROM chain.transactions WHERE batch_id = ${batchId}
      `;
      return { batchId, transactionId: row!.id };
    }

    async function transactionRow(transactionId: string) {
      const [row] = await fx.sql<Record<string, unknown>[]>`
        SELECT * FROM chain.transactions WHERE id = ${transactionId}
      `;
      return row!;
    }

    async function resubmitAudits(batchId: string) {
      return fx.sql<{ reason: string; detail: unknown }[]>`
        SELECT reason, detail FROM audit.events
        WHERE command = 'anchor.batch.resubmit_requested' AND resource_id = ${batchId}
        ORDER BY occurred_at, id
      `;
    }

    it.each([
      ["failed", false],
      ["dropped", true],
      ["reverted", true],
      ["reconciliation_required", false],
    ] as const)(
      "only requests a move for a %s transaction recorded on another chain",
      async (state, hashed) => {
        const txHash = hashed ? randomHash() : null;
        const { batchId, transactionId } = await stuckOnOldChain(state, txHash);
        const before = await transactionRow(transactionId);

        const response = await resubmit(batchId);
        expect(response.statusCode).toBe(200);
        // Nothing was reset: the old chain's worker decides once it has asked the old contract.
        expect(response.json()).toMatchObject({
          confirmationState: state,
          previousState: state,
          attempts: 2,
          moveRequest: { toChainId: 31337, lastCheckedAt: null, waitReason: null },
        });

        const after = await transactionRow(transactionId);
        expect(after).toEqual({
          ...before,
          move_to_chain_id: 31337,
          move_requested_at: expect.any(Date),
          updated_at: expect.any(Date),
        });
        expect(response.json().moveRequest.requestedAt).toBe(
          (after["move_requested_at"] as Date).toISOString(),
        );
        // The row stays on 5611, so only that chain's worker claims it.
        expect(after).toMatchObject({ chain_id: 5611, state, tx_hash: txHash });

        expect(await resubmitAudits(batchId)).toEqual([
          { reason: "chain_move_requested", detail: { fromChainId: 5611, toChainId: 31337, state } },
        ]);
        expect(await fx.sql`
          SELECT 1 FROM chain.anchor_sends WHERE transaction_id = ${transactionId}
        `).toEqual([]);
      },
    );

    it("shows a pending move in the batch list without moving the batch", async () => {
      const { batchId } = await stuckOnOldChain();
      const requested = (await resubmit(batchId)).json().moveRequest;

      const list = await app.inject({
        method: "GET",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}` },
      });
      const item = list.json().items.find((entry: { id: string }) => entry.id === batchId);
      expect(item).toMatchObject({ chainId: 5611, confirmationState: "failed", needsAttention: true });
      expect(item.moveRequest).toEqual(requested);
    });

    it("asking again for the same chain leaves the request and the row untouched", async () => {
      const { batchId, transactionId } = await stuckOnOldChain();
      const first = (await resubmit(batchId)).json().moveRequest;
      // The old chain's worker looked at it once and is waiting.
      const checkedAt = new Date("2026-01-01T00:00:00.000Z");
      await fx.sql`
        UPDATE chain.transactions SET move_checked_at = ${checkedAt}, move_wait_reason = 'open_send'
        WHERE id = ${transactionId}
      `;
      // That worker may be part way through a check: it moves the row only if `updated_at` is
      // still what it read.
      const before = await transactionRow(transactionId);

      const again = await resubmit(batchId);
      expect(again.statusCode).toBe(200);
      expect(again.json().moveRequest).toEqual({
        ...first,
        lastCheckedAt: checkedAt.toISOString(),
        waitReason: "open_send",
      });
      expect(await transactionRow(transactionId)).toMatchObject({
        chain_id: 5611,
        move_to_chain_id: 31337,
        move_requested_at: new Date(first.requestedAt),
      });
      expect(await transactionRow(transactionId)).toEqual(before);
      // A repeated click is not a new decision: the first request's audit stands alone.
      expect(await resubmitAudits(batchId)).toHaveLength(1);
    });

    it("replaces a request for a different chain and records the target it replaced", async () => {
      const { batchId, transactionId } = await stuckOnOldChain();
      await fx.sql`
        UPDATE chain.transactions
        SET move_to_chain_id = 56, move_requested_at = now() - interval '1 day',
            move_checked_at = now(), move_wait_reason = 'signer_pending'
        WHERE id = ${transactionId}
      `;

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(200);
      // The new request starts its wait afresh: nothing has looked at it yet.
      expect(response.json().moveRequest).toMatchObject({ lastCheckedAt: null, waitReason: null });
      const row = await transactionRow(transactionId);
      expect(row).toMatchObject({
        chain_id: 5611, move_to_chain_id: 31337, move_checked_at: null, move_wait_reason: null,
      });
      expect((row["move_requested_at"] as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await resubmitAudits(batchId)).toEqual([
        {
          reason: "chain_move_requested",
          detail: { fromChainId: 5611, toChainId: 31337, state: "failed", replacedToChainId: 56 },
        },
      ]);
    });

    it("does not request a move for a transaction still in flight on its chain", async () => {
      const { batchId, transactionId } = await stuckOnOldChain("submitted", randomHash());
      const before = await transactionRow(transactionId);

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ANCHOR_NOT_RESUBMITTABLE");
      expect(await transactionRow(transactionId)).toEqual(before);
      expect(await resubmitAudits(batchId)).toEqual([]);
    });

    it("does not request a move for a batch that has another transaction", async () => {
      const { batchId, transactionId } = await stuckOnOldChain();
      // The same batch already has a transaction on this chain: the move could only collide
      // with it, and that transaction may anchor the root on its own.
      await fx.sql`
        INSERT INTO chain.transactions (
          id, batch_id, intent_key, chain_id, state, created_at
        )
        SELECT ${randomUUID()}, batch_id, intent_key, 31337, 'failed',
               created_at - interval '1 day'
        FROM chain.transactions WHERE id = ${transactionId}
      `;
      const before = await transactionRow(transactionId);

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ANCHOR_CHAIN_MOVE_BLOCKED");
      expect(response.json().retryable).toBe(false);
      expect(response.json().details).toEqual({
        reason: "other_transaction",
        transactionChainId: 5611,
        currentChainId: 31337,
      });
      expect(await transactionRow(transactionId)).toEqual(before);
      expect(await resubmitAudits(batchId)).toEqual([]);
    });

    it.each([
      [56, "mainnet batch on a testnet deployment"],
      [97, "batch on a chain outside the supported list"],
    ])("does not request a move across environments (%s: %s)", async (fromChainId) => {
      const { batchId, transactionId } = await stuckOnOldChain();
      await fx.sql`UPDATE chain.transactions SET chain_id = ${fromChainId} WHERE id = ${transactionId}`;
      const before = await transactionRow(transactionId);

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ANCHOR_CHAIN_MOVE_BLOCKED");
      expect(response.json().details).toEqual({
        reason: "cross_environment",
        transactionChainId: fromChainId,
        currentChainId: 31337,
      });
      expect(await transactionRow(transactionId)).toEqual(before);
      expect(await resubmitAudits(batchId)).toEqual([]);
    });

    it("shows a move the old chain's worker refused until a person resubmits again", async () => {
      const { batchId, transactionId } = await stuckOnOldChain();
      await resubmit(batchId);
      // What the 5611 worker does on finding the batch there: drop the request, reconcile, audit.
      await fx.sql`
        UPDATE chain.transactions
        SET move_to_chain_id = NULL, move_requested_at = NULL, state = 'reconciliation_required',
            last_error = 'batch_on_chain_transaction_unknown'
        WHERE id = ${transactionId}
      `;
      await fx.sql`
        INSERT INTO audit.events (command, resource_type, resource_id, reason, correlation_id, detail)
        VALUES ('anchor.batch.chain_move_refused', 'anchor_batch', ${batchId}, 'batch_on_chain',
                ${`anchor-worker:${transactionId}`},
                ${fx.sql.json({ fromChainId: 5611, toChainId: 31337, result: "batch_on_chain_transaction_unknown" })})
      `;
      const listItem = async () =>
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/anchor-batches",
            headers: { authorization: `Bearer ${tokens.operatorA}` },
          })
        ).json().items.find((entry: { id: string }) => entry.id === batchId);

      expect(await listItem()).toMatchObject({
        chainId: 5611,
        moveRequest: null,
        moveRefusal: {
          toChainId: 31337,
          reason: "batch_on_chain",
          result: "batch_on_chain_transaction_unknown",
          refusedAt: expect.any(String),
        },
      });

      // A person asks again: the refusal gives way to the new request.
      expect((await resubmit(batchId)).statusCode).toBe(200);
      expect(await listItem()).toMatchObject({ moveRefusal: null, moveRequest: { toChainId: 31337 } });
    });

    it("another company's organization-scoped administrator cannot request a move", async () => {
      const { batchId, transactionId } = await stuckOnOldChain();
      const before = await transactionRow(transactionId);
      const response = await app.inject({
        method: "POST", url: `/api/v1/anchor-batches/${batchId}/resubmit`,
        headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(await transactionRow(transactionId)).toEqual(before);
    });

    it("a resubmit on the row's own chain withdraws a pending move", async () => {
      const batchId = await makeBatch();
      await fx.sql`
        UPDATE chain.transactions
        SET state = 'failed', attempts = 2, chain_id = 31337,
            move_to_chain_id = 56, move_requested_at = now(),
            move_checked_at = now(), move_wait_reason = 'open_send'
        WHERE batch_id = ${batchId}
      `;

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ confirmationState: "created", moveRequest: null });
      const [row] = await fx.sql`
        SELECT state, chain_id, move_to_chain_id, move_requested_at, move_checked_at, move_wait_reason
        FROM chain.transactions WHERE batch_id = ${batchId}
      `;
      expect(row).toEqual({
        state: "created", chain_id: 31337, move_to_chain_id: null, move_requested_at: null,
        move_checked_at: null, move_wait_reason: null,
      });
      expect(await resubmitAudits(batchId)).toEqual([
        { reason: "from_failed", detail: { previousAttempts: 2, withdrawnMoveToChainId: 56 } },
      ]);
    });

    it("resubmits a stuck transaction recorded on this chain", async () => {
      const batchId = await makeBatch();
      // The only difference from the case above: the row is on the configured chain.
      await fx.sql`
        UPDATE chain.transactions
        SET state = 'failed', attempts = 2, tx_hash = ${`0x${"cd".repeat(32)}`}, chain_id = 31337
        WHERE batch_id = ${batchId}
      `;

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(200);
      expect(response.json().previousState).toBe("failed");

      const [row] = await fx.sql<{ state: string; tx_hash: string | null; chain_id: number }[]>`
        SELECT state, tx_hash, chain_id FROM chain.transactions WHERE batch_id = ${batchId}
      `;
      expect(row).toEqual({ state: "created", tx_hash: null, chain_id: 31337 });
    });

    it("resubmission also requires anchor.submit", async () => {
      const batchId = await makeBatch();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/anchor-batches/${batchId}/resubmit`,
        headers: {
          authorization: `Bearer ${tokens.stewardA}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("revocation concurrency (If-Match)", () => {
    function revoke(entryId: string, version: unknown) {
      return app.inject({
        method: "POST",
        url: `/api/v1/registry-entries/${entryId}/revoke`,
        headers: {
          authorization: `Bearer ${tokens.operatorA}`,
          "idempotency-key": idempotencyKey(),
          ...(version === undefined ? {} : { "if-match": String(version) }),
        },
        payload: { reasonCode: "SOURCE_CORRECTION" },
      });
    }

    it("rejects when the version to revoke is not stated", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();

      const response = await revoke(published.entryId, undefined);
      expect(response.statusCode).toBe(428);
    });

    it("rejects a stale revoke request when a new version was published after lookup", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      const first = (await publish(tokens.operatorA, { publicKey })).json();

      // Someone published a correction. A request meant to revoke v1 would now revoke v2.
      await publish(tokens.operatorA, { publicKey });

      const response = await revoke(first.entryId, `"${first.version}"`);
      expect(response.statusCode).toBe(412);
      expect(response.json().details.currentVersion).toBe("2");
    });

    it("public lookup response exposes the current version as ETag", async () => {
      const publicKey = `KEY-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/registries/project/${publicKey}`,
      });

      // Must equal the body version. Otherwise the client cannot tell which one goes into
      // If-Match.
      expect(response.headers["etag"]).toBe(`"${response.json().version}"`);
    });
  });

  it("an account without permission cannot publish", async () => {
    const response = await publish(tokens.stewardA);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("administrator");
  });

  describe("public lookup (unauthenticated)", () => {
    it("reads a published projection without auth", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/registries/project/${publicKey}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("published");
    });

    it("returns 404 for an unknown key", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/public/registries/project/DOES-NOT-EXIST",
      });
      expect(response.statusCode).toBe(404);
    });

    it("response includes limitations and legalEffect", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/public/registries/project/${publicKey}`,
        })
      ).json();

      expect(body.limitations).toBeInstanceOf(Array);
      expect(body.legalEffect).toBe("none");
    });

    it("does not hide correction and revocation history", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });
      await publish(tokens.operatorA, { publicKey });

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/public/registries/project/${publicKey}`,
        })
      ).json();

      expect(body.version).toBe("2");
      expect(body.history.length).toBe(1);
      expect(body.history[0].status).toBe("superseded");
    });

    it("response has no internal ownership information", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/public/registries/project/${publicKey}`,
        })
      ).json();
      expect(JSON.stringify(body)).not.toContain(fx.orgA);
    });
  });

  /** Waits until `count` sessions of this database are waiting on a lock. */
  async function waitForBlockedSessions(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await fx.sql<{ blocked: number }[]>`
        SELECT count(*)::INT AS blocked FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      if (row!.blocked >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`fewer than ${count} sessions blocked within 5s`);
  }

  describe("anchor and inclusion proof", () => {
    it("anchors only the selected project and leaves another project pending", async () => {
      const [role] = await fx.appSql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const projectA = await projectWithKey("ANCHOR-A-" + randomUUID());
      const projectB = await projectWithKey("ANCHOR-B-" + randomUUID());
      const firstA = (await publish(tokens.operatorA, { subjectId: projectA })).json();
      const nextA = (await publish(tokens.operatorA, { subjectId: projectA })).json();
      const versionB = (await publish(tokens.operatorA, { subjectId: projectB })).json();
      const scoped = await signIn(app, await addGovernanceAccount(fx, "administrator", {
        projectId: projectA, assurance: "high_assurance",
      }));
      const create = (token: string, payload: object) => app.inject({
        method: "POST", url: "/api/v1/anchor-batches",
        headers: { authorization: "Bearer " + token, "idempotency-key": idempotencyKey() },
        payload,
      });

      expect((await create(tokens.operatorA, {})).statusCode).toBe(400);
      expect((await create(scoped, { projectId: projectB })).statusCode).toBe(403);
      const response = await create(scoped, { projectId: projectA });
      expect(response.statusCode, response.body).toBe(200);
      const batch = response.json();
      expect(batch).toMatchObject({ recordCount: 2, confirmationState: "created" });
      const [audit] = await fx.sql`SELECT project_id FROM audit.events
        WHERE resource_id = ${batch.id} AND command = 'anchor.batch.created'`;
      expect(audit?.project_id).toBe(projectA);
      const leaves = await fx.sql<{ entry_version_id: string }[]>`
        SELECT entry_version_id FROM chain.anchor_batch_leaves WHERE batch_id = ${batch.id}
      `;
      expect(leaves.map(row => row.entry_version_id).sort()).toEqual([firstA.id, nextA.id].sort());
      await expect(fx.sql`
        INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
        VALUES (${batch.id}, ${"0x" + "99".repeat(32)}, ${versionB.id}, 2)
      `).rejects.toMatchObject({ code: "23514" });
      const otherCompany = await signIn(app, fx.operatorB);
      expect((await create(otherCompany, { projectId: projectA })).statusCode).toBe(403);
      await expect(withActor(fx.appSql, { subjectId: fx.operatorSubjectB }, tx => tx`
        INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
        VALUES (${batch.id}, ${"0x" + "99".repeat(32)}, ${versionB.id}, 2)
      `)).rejects.toMatchObject({ code: "23514" });
      expect((await create(scoped, { projectId: projectA })).json().code).toBe("ANCHOR_BATCH_EMPTY");
      const other = await create(tokens.operatorA, { projectId: projectB });
      expect(other.statusCode, other.body).toBe(200);
      expect(other.json().recordCount).toBe(1);
    });

    it("concurrent batch requests do not anchor the same version twice", async () => {
      // Both requests see the same unanchored versions. Without serialization both build a batch
      // from them, and one version ends up in two roots — its inclusion becomes ambiguous.
      const publicKey = "CON-" + randomUUID().slice(0, 8);
      const published = (await publish(tokens.operatorA, { publicKey })).json();
      const projectId = await projectWithKey(publicKey);
      const create = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/anchor-batches",
          headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
          payload: { projectId },
        });

      // Force the overlap. Holding a lock on chain.transactions stops each request just before
      // its last insert — after it has read the unanchored versions. Without it the two requests
      // happen to run one after the other and the race never shows.
      const blocker = await fx.sql.reserve();
      let pending: ReturnType<typeof create>[] = [];
      try {
        await blocker`BEGIN`;
        await blocker`LOCK TABLE chain.transactions IN SHARE MODE`;
        pending = [create(), create()];
        await waitForBlockedSessions(2);
      } finally {
        await blocker`COMMIT`;
        blocker.release();
      }
      const responses = await Promise.all(pending);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 422]);
      const leaves = await fx.sql`
        SELECT batch_id FROM chain.anchor_batch_leaves WHERE entry_version_id = ${published.id}
      `;
      expect(leaves).toHaveLength(1);
    });

    it("the database refuses a version in two batches", async () => {
      // The invariant does not rest on the route alone. Any other writer hits the same wall.
      const [leaf] = await fx.sql<{ entry_version_id: string; leaf_hash: string }[]>`
        SELECT entry_version_id, leaf_hash FROM chain.anchor_batch_leaves LIMIT 1
      `;
      const otherBatch = randomUUID();
      await fx.sql`
        INSERT INTO chain.anchor_batches (
          id, batch_id, merkle_root, manifest_hash,
          manifest_object_key, schema_version, record_count
        ) VALUES (
          ${otherBatch}, ${`0x${otherBatch.replace(/-/g, "").repeat(2)}`},
          ${`0x${"11".repeat(32)}`}, ${`0x${"22".repeat(32)}`}, 'manifests/dup.json', '1', 1
        )
      `;

      await expect(
        fx.sql`
          INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
          VALUES (${otherBatch}, ${leaf!.leaf_hash}, ${leaf!.entry_version_id}, 0)
        `,
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("verifies the proof off-chain", async () => {
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();

      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: { projectId: await projectWithKey(publicKey) },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/proofs/${published.id}`,
      });

      expect(response.statusCode).toBe(200);
      const proof = response.json();
      expect(
        verifyMerkleProof(proof.leafHash as Hex, proof.proof as Hex[], proof.root as Hex),
      ).toBe(true);
      expect(proof.merkleVerified).toBe(true);
    });

    it("proof includes the spec needed to rebuild the leaf", async () => {
      // Without a spec version, a verifier does not know **which spec** to rebuild with.
      // The proof then becomes "trust me" rather than a reproducible check.
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (
        await publish(tokens.operatorA, {
          publicKey,
          policyVersion: "mn-core-9.9.9",
          schemaVersion: "project-registry-9",
        })
      ).json();

      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: { projectId: await projectWithKey(publicKey) },
      });

      const proof = (
        await app.inject({ method: "GET", url: `/api/v1/public/proofs/${published.id}` })
      ).json();

      // Returns the value given at publication — not a hard-coded constant.
      expect(proof.policyVersion).toBe("mn-core-9.9.9");
      expect(proof.schemaVersion).toBe("project-registry-9");
      expect(proof.serializationVersion).toBe("2");

      const exported=await app.inject({method:"GET",url:`/api/v1/registry-entries/versions/${published.id}/review-bundle`,headers:{authorization:`Bearer ${tokens.operatorA}`}});
      expect(exported.statusCode,exported.body).toBe(200);
      expect(exported.json().bundle.reviews).toEqual([]);
      expect(exported.json().projection.reviewCommitment.reviewCount).toBe("0");
      expect(hashLeaf(exported.json().leaf)).toBe(proof.leafHash);
      const otherToken=await signIn(app,fx.operatorB);
      expect((await app.inject({method:"GET",url:`/api/v1/registry-entries/versions/${published.id}/review-bundle`,headers:{authorization:`Bearer ${otherToken}`}})).statusCode).toBe(403);
      await expect(fx.sql`UPDATE core.registry_review_bundles SET bundle='{}' WHERE entry_version_id=${published.id}`).rejects.toThrow();

      expect((await app.inject({method:"GET",url:`/api/v1/registry-entries/versions/${published.id}/review-bundle`})).statusCode).toBe(401);

      // Carries no subject. Only the spec name.
      expect(proof.subjectId).toBeUndefined();
    });

    it("AC-23: included is false unless confirmed", async () => {
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();
      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: { projectId: await projectWithKey(publicKey) },
      });

      const proof = (
        await app.inject({ method: "GET", url: `/api/v1/public/proofs/${published.id}` })
      ).json();

      expect(proof.confirmationState).toBe("created");
      // The Merkle proof holds, but the chain has not finalized, so it is not marked included.
      expect(proof.merkleVerified).toBe(true);
      expect(proof.included).toBe(false);
    });

    it("AC-23: states what the proof does not prove", async () => {
      const publicKey = `PRF-${randomUUID().slice(0, 8)}`;
      const published = (await publish(tokens.operatorA, { publicKey })).json();
      await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: { projectId: await projectWithKey(publicKey) },
      });

      const proof = (
        await app.inject({ method: "GET", url: `/api/v1/public/proofs/${published.id}` })
      ).json();

      const doesNotProve = (proof.doesNotProve as string[]).join(" ");
      expect(doesNotProve).toContain("Factual accuracy");
      expect(doesNotProve).toContain("Legal effect");
      expect(doesNotProve).toContain("Investment suitability");
      expect((proof.proves as string[]).join(" ")).toContain("included");
    });

    it("an unanchored version has no proof", async () => {
      const published = (await publish(tokens.operatorA)).json();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/public/proofs/${published.id}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().retryable).toBe(true);
    });

    it("cannot modify an anchor batch", async () => {
      const publicKey = "IMM-" + randomUUID().slice(0, 8);
      await publish(tokens.operatorA, { publicKey });
      const batch = (
        await app.inject({
          method: "POST",
          url: "/api/v1/anchor-batches",
          headers: {
            authorization: `Bearer ${tokens.operatorA}`,
            "idempotency-key": idempotencyKey(),
          },
          payload: { projectId: await projectWithKey(publicKey) },
        })
      ).json();

      await expect(
        fx.sql`
          UPDATE chain.anchor_batches SET merkle_root = ${"0x" + "99".repeat(32)}
          WHERE id = ${batch.id}
        `,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });
  });
});
