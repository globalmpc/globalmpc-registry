import { freezeReviewBundle } from "../src/services/review-commitment.js";
import { hashProjection } from "@mpc/canonical";
import { withActor } from "@mpc/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildServer } from "../src/server.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  idempotencyKey,
  issueTestSession,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture, syncSubjectAssurance } from "./helpers/db.js";
import { hashSnapshotInput } from "../src/services/evidence-snapshot.js";
import { bindWalletByProof } from "./helpers/wallets.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describe("evidence snapshot hash", () => {
  const base = {
    claimIds: ["c1", "c2"],
    artifactIds: ["a1"],
    receiptIds: ["r1"],
    claimFingerprints: [
      { id: "c1", valueText: "100", grade: "verified" },
      { id: "c2", valueText: "200", grade: "partially_verified" },
    ],
  };

  it("yields the same hash regardless of order", () => {
    const reordered = {
      claimIds: ["c2", "c1"],
      artifactIds: ["a1"],
      receiptIds: ["r1"],
      claimFingerprints: [...base.claimFingerprints].reverse(),
    };
    expect(hashSnapshotInput(reordered)).toBe(hashSnapshotInput(base));
  });

  it("changes the hash when a claim value changes", () => {
    const changed = {
      ...base,
      claimFingerprints: [
        { id: "c1", valueText: "101", grade: "verified" },
        base.claimFingerprints[1]!,
      ],
    };
    expect(hashSnapshotInput(changed)).not.toBe(hashSnapshotInput(base));
  });

  it("changes the hash when the grade changes", () => {
    const changed = {
      ...base,
      claimFingerprints: [
        { id: "c1", valueText: "100", grade: "partially_verified" },
        base.claimFingerprints[1]!,
      ],
    };
    expect(hashSnapshotInput(changed)).not.toBe(hashSnapshotInput(base));
  });

  it("changes the hash when an artifact is added", () => {
    expect(hashSnapshotInput({ ...base, artifactIds: ["a1", "a2"] })).not.toBe(
      hashSnapshotInput(base),
    );
  });
});

describeDb("Verification and EIP-712 signature", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let config: AppConfig;
  let claimId: string;
  let stewardToken: string;
  let reviewerToken: string;
  let resolverToken: string;
  let resolverSubjectId: string;
  let memberToken: string;

  // Generates a new key per run. wallet_address is globally UNIQUE on (address, chain_id),
  // so a fixed key collides with rows from earlier runs.
  const reviewerAccount = privateKeyToAccount(generatePrivateKey());
  /** The reviewer wallet in the DB is set to this address, so headers must use it too. */
  const reviewerWallet = reviewerAccount.address.toLowerCase();
  const outsiderAccount = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    fx = await setupFixture();
    config = loadConfig(testEnv());

    // Sets the reviewer's wallet address to this key's address. Verifying a real signature
    // requires the test to hold that key.
    await fx.sql`
      UPDATE core.wallet_identities
      SET wallet_address = ${reviewerAccount.address.toLowerCase()}
      WHERE subject_id = ${fx.reviewerSubjectA}
    `;

    app = await buildServer(config, fx.appSql);

    stewardToken = await signIn(app, fx.stewardA);
    // The reviewer's DB address was changed, so it logs in directly with that key.
    reviewerToken = await signIn(app, { address: reviewerWallet as `0x${string}`, account: reviewerAccount });
    for (const role of ["reviewer", "project_member"]) {
      const subject=randomUUID();
      await fx.sql`INSERT INTO core.subjects(id,kind,display_name,assurance_level)
        VALUES(${subject},'person',${`Dispute ${role}`},'high_assurance')`;
      await fx.sql`INSERT INTO core.role_bindings(id,subject_id,organization_id,role)
        VALUES(${randomUUID()},${subject},${role === "reviewer" ? fx.reviewOrgA : fx.orgA},${role})`;
      const token=await issueTestSession(fx.appSql,subject,{firstFactor:"email_code",secondFactor:"passkey"});
      if(role === "reviewer") {resolverToken=token;resolverSubjectId=subject;} else memberToken=token;
    }

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        claimType: "mining_right_registration",
        valueText: "MV-012345",
        sourceCoordinate: { document: "extract", page: "1" },
        evidenceTier: "P1",
      },
    });
    claimId = claim.json().id;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function createCase(evidenceClaimId = claimId, options: {credentialId?:string;schemaId?:string;conflictStatus?:"none"|"disclosed_resolved"} = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: options.schemaId ?? fx.schemaA,
        claimIds: [evidenceClaimId],
        reviewerSubjectId: fx.reviewerSubjectA,
        credentialId: options.credentialId ?? fx.credentialA,
        conflictStatus: options.conflictStatus ?? "none",
      },
    });
    return response.json() as { id: string; assignmentId: string; evidenceSnapshotHash: string };
  }

  async function draftAttestation(
    caseId: string,
    assignmentId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/verification-cases/${caseId}/attestations`,
      headers: { authorization: `Bearer ${reviewerToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        assignmentId,
        attestationType: "professional_signoff",
        claimScope: [claimId],
        findings: [{ note: "registration status checked" }],
        citations: [{ source: "registry-extract" }],
        limitations: "Limited to registration status; does not confirm completeness of rights",
        ...overrides,
      },
    });
  }

  function requestSignature(attestationId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/attestations/${attestationId}/signature-requests`,
      headers: { authorization: `Bearer ${reviewerToken}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });
  }

  async function signTypedData(
    typedData: { domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown> },
    account = reviewerAccount,
  ) {
    // viem's typed-data generics require literal types. The response is a runtime value,
    // so it is widened once at the call site.
    const payload = {
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        issuedAt: BigInt(typedData.message["issuedAt"] as string),
        expiresAt: BigInt(typedData.message["expiresAt"] as string),
      },
    } as unknown as Parameters<typeof account.signTypedData>[0];

    return account.signTypedData(payload);
  }

  function submitSignature(attestationId: string, body: Record<string, unknown>, token = reviewerToken, key = idempotencyKey()) {
    return app.inject({
      method: "POST",
      url: `/api/v1/attestations/${attestationId}/signatures`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      payload: body,
    });
  }

  it("cannot create a case without evidence", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: fx.schemaA,
        claimIds: [],
        reviewerSubjectId: fx.reviewerSubjectA,
        credentialId: fx.credentialA,
        conflictStatus: "none",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("assigned reviewer finds their case and review scope in the list", async () => {
    const created = await createCase();

    // The assigner (steward) and the signer (reviewer) differ, so the flow breaks if the
    // reviewer has no path to their own assignment.
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/verification-cases`,
      headers: { authorization: `Bearer ${reviewerToken}` },
    });

    expect(response.statusCode).toBe(200);
    const found = (response.json().items as { id: string; claimIds: string[] }[]).find(
      (item) => item.id === created.id,
    );

    // Review scope is restored as a list, not as a snapshot hash. A hash only tells whether
    // something changed, not what it was.
    expect(found?.claimIds).toEqual([claimId]);
  });

  it("does not list cases to another company's administrator", async () => {
    await createCase();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/verification-cases`,
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });

    // Operator B's organization-scoped binding does not reach project A.
    expect(response.statusCode).toBe(403);
    expect(response.json().items).toBeUndefined();
  });

  it("assignment scope cannot be changed afterwards", async () => {
    const created = await createCase();

    // If scope were editable, "the evidence the signature covers" could change later. This is
    // not a permission check: mpc_app is not granted UPDATE/DELETE (0011).
    await expect(
      fx.appSql`
        DELETE FROM core.verification_case_claims WHERE case_id = ${created.id}
      `,
    ).rejects.toThrow(/permission denied/i);
  });

  describe("case state transitions", () => {
    function transition(caseId: string, version: unknown, body: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/api/v1/verification-cases/${caseId}/transitions`,
        headers: {
          authorization: `Bearer ${stewardToken}`,
          "idempotency-key": idempotencyKey(),
          ...(version === undefined ? {} : { "if-match": String(version) }),
        },
        payload: body,
      });
    }

    it("records a changes request with its reason", async () => {
      const created = await createCase();

      const response = await transition(created.id, '"1"', {
        toState: "changes_requested",
        reason: "registry lookup has no reference date",
      });

      // Order is assigned → in_review → changes_requested. assigned cannot go directly
      // to changes_requested.
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("INVALID_STATE_TRANSITION");
      // Tells what can be done next. Blocking alone leaves the user guessing.
      expect(response.json().details.allowedTransitions).toContain("in_review");
    });

    it("records allowed transitions with history", async () => {
      const created = await createCase();

      const toReview = await transition(created.id, '"1"', {
        toState: "in_review",
        reason: "starting review",
      });
      expect(toReview.statusCode).toBe(200);
      expect(toReview.json().version).toBe(2);

      const changes = await transition(created.id, '"2"', {
        toState: "changes_requested",
        reason: "registry lookup has no reference date",
      });
      expect(changes.statusCode).toBe(200);

      const list = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/verification-cases`,
        headers: { authorization: `Bearer ${stewardToken}` },
      });
      const found = (list.json().items as { id: string; transitions: unknown[] }[]).find(
        (item) => item.id === created.id,
      );

      // Does not hide the path taken. History remains even after going back.
      expect(found?.transitions).toHaveLength(2);
      expect((found!.transitions[1] as { reason: string }).reason).toContain("reference date");
    });

    it("cannot change state without a reason", async () => {
      const created = await createCase();
      const response = await transition(created.id, '"1"', { toState: "in_review", reason: "" });
      expect(response.statusCode).toBe(400);
    });

    it("rejects without If-Match", async () => {
      const created = await createCase();
      const response = await transition(created.id, undefined, {
        toState: "in_review",
        reason: "start review",
      });
      expect(response.statusCode).toBe(428);
    });

    it("returns 412 for a stale version", async () => {
      const created = await createCase();
      await transition(created.id, '"1"', { toState: "in_review", reason: "start" });

      const stale = await transition(created.id, '"1"', {
        toState: "changes_requested",
        reason: "changes needed",
      });
      expect(stale.statusCode).toBe(412);
    });
  });

  describe("attestation disputes", () => {
    async function signOne(evidenceClaimId = claimId, options: {credentialId?:string;schemaId?:string;conflictStatus?:"none"|"disclosed_resolved"} = {}) {
      const created = await createCase(evidenceClaimId, options);
      const draft = (await draftAttestation(created.id, created.assignmentId, {claimScope:[evidenceClaimId]})).json();
      const signatureRequest = (await requestSignature(draft.id)).json();
      const signature = await signTypedData(signatureRequest.typedData);
      await submitSignature(draft.id, {
        signatureRequestId: signatureRequest.signatureRequestId,
        signature,
      });
      const frozen=await withActor(fx.appSql, { subjectId: fx.operatorSubjectA },tx=>freezeReviewBundle(tx,fx.projectA,"verification",draft.id,{}));
      expect(frozen.commitment.reviewCount).toBe("1");
      expect(frozen.commitment.independentlyVerifiableCount).toBe("1");
      expect(frozen.bundle.reviews[0]!.signature).toBe(signature);
      expect(frozen.bundleHash).toBe(hashProjection(frozen.bundle as never));
      expect(frozen.bundle.reviews[0]!.signingEnvelope).toBeTruthy();
      await expect(fx.sql`UPDATE core.verification_attestations SET signing_envelope='{}' WHERE id=${draft.id}`).rejects.toThrow("Signed envelope is immutable");
      await expect(withActor(fx.appSql, { subjectId: fx.operatorSubjectB },tx=>freezeReviewBundle(tx,fx.projectA,"verification",draft.id,{}))).rejects.toMatchObject({code:"REVIEW_SUBJECT_NOT_SIGNED"});
      const [claim]=await fx.sql<{claim_type:string}[]>`SELECT claim_type FROM core.claims WHERE id=${evidenceClaimId}`;
      const excluded=await withActor(fx.appSql, { subjectId: fx.operatorSubjectA },tx=>freezeReviewBundle(tx,fx.projectA,"project",fx.projectA,{evidenceLedger:{items:[{claimType:claim!.claim_type,status:"not_applicable"}]}}));
      expect(excluded.bundle.reviews).toEqual([]);
      return draft.id as string;
    }

    function dispute(attestationId: string, body: Record<string, unknown>, token = stewardToken) {
      return app.inject({
        method: "POST",
        url: `/api/v1/attestations/${attestationId}/disputes`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: body,
      });
    }

    it("a dispute leaves the signed body unchanged", async () => {
      const attestationId = await signOne();

      const [before] = await fx.sql<{ payload_hash: string; signature: string }[]>`
        SELECT payload_hash, signature FROM core.verification_attestations
        WHERE id = ${attestationId}
      `;

      const response = await dispute(attestationId, {
        reasonCode: "EVIDENCE_QUESTIONED",
        detail: "reference date of the registry lookup is unclear",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("disputed");

      const [after] = await fx.sql<{ payload_hash: string; signature: string; state: string }[]>`
        SELECT payload_hash, signature, state FROM core.verification_attestations
        WHERE id = ${attestationId}
      `;

      // Deleting the signature loses "who judged what, and when". Only the state changes.
      expect(after!.payload_hash).toBe(before!.payload_hash);
      expect(after!.signature).toBe(before!.signature);
      expect(after!.state).toBe("disputed");
    });

    it("records the dispute content", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, {
        reasonCode: "SCOPE_MISMATCH",
        detail: "review scope does not match the claim",
      });

      const rows = await fx.sql<{ reason_code: string; detail: string }[]>`
        SELECT reason_code, detail FROM core.attestation_disputes
        WHERE attestation_id = ${attestationId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason_code).toBe("SCOPE_MISMATCH");
    });

    it("rejects a dispute without a reason", async () => {
      const attestationId = await signOne();
      const response = await dispute(attestationId, { reasonCode: "X", detail: "" });
      expect(response.statusCode).toBe(400);
    });

    function resolve(disputeId: string, body: Record<string, unknown>, token = resolverToken, key = idempotencyKey()) {
      return app.inject({
        method: "POST",
        url: `/api/v1/disputes/${disputeId}/resolution`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": key,
        },
        payload: body,
      });
    }

    async function disputeOf(attestationId: string) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/attestations/${attestationId}/disputes`,
        headers: { authorization: `Bearer ${stewardToken}` },
      });
      return response.json().items as { id: string; resolvedAt: string | null }[];
    }

    it.each(["none","disclosed_resolved"] as const)("restores standing only after every objection is dismissed (conflict=%s)", async (conflictStatus) => {
      const created=await app.inject({method:"POST",url:`/api/v1/projects/${fx.projectA}/claims`,
        headers:{authorization:`Bearer ${stewardToken}`,"idempotency-key":idempotencyKey()},
        payload:{claimType:"mining_right_registration",valueText:"dispute standing",sourceCoordinate:{document:"extract",page:"2"},evidenceTier:"P1"}});
      expect(created.statusCode,created.body).toBe(200);
      const evidenceClaimId=created.json().id;
      const standing=async()=> (await fx.sql`SELECT verification_state,grade FROM core.claims WHERE id=${evidenceClaimId}`)[0];
      const attestationId=await signOne(evidenceClaimId,{conflictStatus}), before=await standing();
      expect(before!.verification_state).toBe("analyst_checked");
      expect((await dispute(attestationId,{reasonCode:"A",detail:"first"})).statusCode).toBe(200);
      expect((await standing())!.verification_state).toBe("unreviewed");
      expect((await standing())!.grade).not.toBe(before!.grade);
      await dispute(attestationId,{reasonCode:"B",detail:"second"});
      const objections=await disputeOf(attestationId);
      expect((await resolve(objections[0]!.id,{outcome:"dismissed",resolution:"Checked first"})).statusCode).toBe(200);
      expect((await standing())!.verification_state).toBe("unreviewed");
      expect((await resolve(objections[1]!.id,{outcome:"dismissed",resolution:"Checked second"})).statusCode).toBe(200);
      expect(await standing()).toEqual(before);
    });

    it("members can raise objections but only a separate independent reviewer can resolve them, including replays", async () => {
      const attestationId=await signOne();
      expect((await dispute(attestationId,{reasonCode:"X",detail:"Needs review"},memberToken)).statusCode).toBe(200);
      const [raised]=await disputeOf(attestationId), key=idempotencyKey();
      const body={outcome:"dismissed",resolution:"Independent source check"};
      expect((await resolve(raised!.id,body,memberToken)).statusCode).toBe(403);
      for(const token of [stewardToken,reviewerToken]) {
        const denied=await resolve(raised!.id,body,token);
        expect(denied.statusCode,denied.body).toBe(403);
        expect(denied.json().code).toBe("DISPUTE_RESOLUTION_NOT_INDEPENDENT");
      }
      const accepted=await resolve(raised!.id,body,resolverToken,key);
      expect(accepted.statusCode,accepted.body).toBe(200);
      expect(accepted.json().attestationState).toBe("active");
      expect((await resolve(raised!.id,body,memberToken,key)).statusCode).toBe(403);
      const [saved]=await fx.sql`SELECT signature,state FROM core.verification_attestations WHERE id=${attestationId}`;
      expect(saved!.signature).not.toBe("");expect(saved!.state).toBe("active");
      const listed=await app.inject({method:"GET",url:`/api/v1/projects/${fx.projectA}/verification-cases`,headers:{authorization:`Bearer ${resolverToken}`}});
      expect(listed.json().items).toEqual(expect.arrayContaining([expect.objectContaining({latestAttestation:{id:attestationId,state:"active"}})]));
    });

    it.each([false,true])("restores the same latest signed metadata with tied times and reversed insertion (reverse=%s)", async (reverse) => {
      const original=await signOne(), ids=[randomUUID(),randomUUID()].sort(), newerDraft=randomUUID();
      const [clock]=await fx.sql`SELECT now()+interval '1 second' AS at`;
      for(const id of reverse ? [...ids].reverse() : ids) await fx.sql`
        INSERT INTO core.verification_attestations
        SELECT (jsonb_populate_record(NULL::core.verification_attestations,to_jsonb(a)||jsonb_build_object('id',${id}::text,'created_at',${clock!.at}::timestamptz))).*
        FROM core.verification_attestations a WHERE a.id=${original}`;
      await fx.sql`INSERT INTO core.verification_attestations
        SELECT (jsonb_populate_record(NULL::core.verification_attestations,to_jsonb(a)||jsonb_build_object('id',${newerDraft}::text,'state','draft','signature','','created_at',${clock!.at}::timestamptz+interval '1 second'))).*
        FROM core.verification_attestations a WHERE a.id=${original}`;
      const list=await app.inject({method:"GET",url:`/api/v1/projects/${fx.projectA}/verification-cases`,headers:{authorization:`Bearer ${resolverToken}`}});
      const [source]=await fx.sql`SELECT case_id FROM core.verification_attestations WHERE id=${original}`;
      expect(list.json().items.find((row:{id:string})=>row.id===source!.case_id).latestAttestation).toEqual({id:ids[1],state:"signed"});
    });

    it.each(["revoked credential","expired credential","retired schema","new schema version","older activated schema","stale claim","new policy"])(
      "records dismissal without restoring invalid support after %s", async (change) => {
        const credentialId=randomUUID(), schemaId=randomUUID();
        await fx.sql`INSERT INTO core.credentials SELECT (jsonb_populate_record(NULL::core.credentials,
          to_jsonb(c)||jsonb_build_object('id',${credentialId}::text))).* FROM core.credentials c WHERE id=${fx.credentialA}`;
        await fx.sql`INSERT INTO core.attestation_schemas SELECT (jsonb_populate_record(NULL::core.attestation_schemas,
          to_jsonb(s)||jsonb_build_object('id',${schemaId}::text,'schema_key',${`restore-${schemaId}`}::text))).* FROM core.attestation_schemas s WHERE id=${fx.schemaA}`;
        const created=await app.inject({method:"POST",url:`/api/v1/projects/${fx.projectA}/claims`,
          headers:{authorization:`Bearer ${stewardToken}`,"idempotency-key":idempotencyKey()},
          payload:{claimType:"mining_right_registration",valueText:`Restoration ${change}`,sourceCoordinate:{document:"extract",page:"3"},evidenceTier:"P1"}});
        expect(created.statusCode,created.body).toBe(200);
        const evidenceClaimId=created.json().id;
        const attestationId=await signOne(evidenceClaimId,{credentialId,schemaId});
        const [before]=await fx.sql`SELECT signature,payload_hash,credential_status_snapshot FROM core.verification_attestations WHERE id=${attestationId}`;
        expect((await dispute(attestationId,{reasonCode:"DATE",detail:"Check the reference date"})).statusCode).toBe(200);
        if(change === "revoked credential") await fx.sql`UPDATE core.credentials SET current_status='revoked',revoked_at=now() WHERE id=${credentialId}`;
        if(change === "expired credential") await fx.sql`UPDATE core.credentials SET expires_at=now()-interval '1 hour' WHERE id=${credentialId}`;
        if(change === "retired schema") await fx.sql`UPDATE core.attestation_schemas SET state='retired' WHERE id=${schemaId}`;
        if(change === "new schema version" || change === "older activated schema") await fx.sql`INSERT INTO core.attestation_schemas SELECT (jsonb_populate_record(NULL::core.attestation_schemas,
          to_jsonb(s)||jsonb_build_object('id',${randomUUID()}::text,'schema_version','2','created_at',now()-CASE WHEN ${change === "older activated schema"} THEN interval '1 year' ELSE interval '0' END))).* FROM core.attestation_schemas s WHERE id=${schemaId}`;
        if(change === "stale claim") await fx.sql`UPDATE core.claims SET stale_since=now(),stale_reason='Source withdrawn during dispute' WHERE id=${evidenceClaimId}`;
        if(change === "new policy") await fx.sql`INSERT INTO core.compliance_policy_sets(id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
          VALUES(${randomUUID()},${`restore-${schemaId}`},'1','registry_publication','MNG',now()-interval '1 minute','{}','effective')`;
        const [objection]=await disputeOf(attestationId);
        const response=await resolve(objection!.id,{outcome:"dismissed",resolution:"Date checked; current review basis still needs attention"});
        expect(response.statusCode,response.body).toBe(200);
        expect(response.json().attestationState).toBe("stale_candidate");
        const [after]=await fx.sql`SELECT signature,payload_hash,credential_status_snapshot,state,stale_reason FROM core.verification_attestations WHERE id=${attestationId}`;
        expect(after).toMatchObject(before!);expect(after!.stale_reason).toContain("Current review basis changed");
        const [claim]=await fx.sql`SELECT verification_state FROM core.claims WHERE id=${evidenceClaimId}`;
        expect(claim!.verification_state).toBe("unreviewed");
        expect((await disputeOf(attestationId))[0]!.resolvedAt).not.toBeNull();
      },
    );

    it("requires known resolver organization and accepts current credential provenance", async () => {
      const attestationId=await signOne();await dispute(attestationId,{reasonCode:"X",detail:"Check"});
      const [objection]=await disputeOf(attestationId), key=idempotencyKey(), body={outcome:"dismissed",resolution:"Checked"};
      const unknownBinding=randomUUID();
      await fx.sql`UPDATE core.role_bindings SET revoked_at=now() WHERE subject_id=${resolverSubjectId} AND revoked_at IS NULL`;
      await fx.sql`INSERT INTO core.role_bindings(id,subject_id,role) VALUES(${unknownBinding},${resolverSubjectId},'reviewer')`;
      const credential=randomUUID();
      try {
        const unknown=await resolve(objection!.id,body,resolverToken,key);
        expect(unknown.statusCode,unknown.body).toBe(403);expect(unknown.json().code).toBe("DISPUTE_RESOLUTION_NOT_INDEPENDENT");
        expect((await disputeOf(attestationId))[0]!.resolvedAt).toBeNull();
        await fx.sql`INSERT INTO core.credentials(id,subject_id,organization_id,issuer_reference,credential_type,issued_at)
          VALUES(${credential},${resolverSubjectId},${fx.reviewOrgA},'Independent organization','competent_person',now()-interval '1 day')`;
        const known=await resolve(objection!.id,body,resolverToken,key);
        expect(known.statusCode,known.body).toBe(200);expect(known.json().attestationState).toBe("active");
      } finally {
        await fx.sql`UPDATE core.role_bindings SET revoked_at=now() WHERE id=${unknownBinding}`;
        await fx.sql`INSERT INTO core.role_bindings(id,subject_id,organization_id,role) VALUES(${randomUUID()},${resolverSubjectId},${fx.reviewOrgA},'reviewer')`;
      }
    });

    it.each(["before","after","reactivated"])("tracks actual schema activation %s signing, independently of creation order", async (timing) => {
      const first=randomUUID(),second=randomUUID(),family=`epoch-${first}`;
      await fx.sql`INSERT INTO core.attestation_schemas SELECT (jsonb_populate_record(NULL::core.attestation_schemas,
        to_jsonb(s)||jsonb_build_object('id',${first}::text,'schema_key',${family}::text))).* FROM core.attestation_schemas s WHERE id=${fx.schemaA}`;
      await fx.sql`INSERT INTO core.attestation_schemas SELECT (jsonb_populate_record(NULL::core.attestation_schemas,
        to_jsonb(s)||jsonb_build_object('id',${second}::text,'schema_version','2','state',${timing === "after" ? "draft" : "active"}::text,'created_at',now()-interval '1 year'))).* FROM core.attestation_schemas s WHERE id=${first}`;
      const attestationId=await signOne(claimId,{schemaId:timing === "after" ? first : second});
      const [before]=await fx.sql`SELECT signature,payload_hash,schema_activation_epoch FROM core.verification_attestations WHERE id=${attestationId}`;
      expect(before!.schema_activation_epoch).not.toBeNull();
      await dispute(attestationId,{reasonCode:"X",detail:"Check"});
      if(timing === "after") await fx.sql`UPDATE core.attestation_schemas SET state='active' WHERE id=${second}`;
      if(timing === "reactivated") {
        await fx.sql`UPDATE core.attestation_schemas SET state='retired' WHERE id=${first}`;
        await fx.sql`UPDATE core.attestation_schemas SET state='active' WHERE id=${first}`;
      }
      const [objection]=await disputeOf(attestationId);
      const dismissed=await resolve(objection!.id,{outcome:"dismissed",resolution:"Checked original finding"});
      expect(dismissed.statusCode,dismissed.body).toBe(200);
      expect(dismissed.json().attestationState).toBe(timing === "before" ? "active" : "stale_candidate");
      const [after]=await fx.sql`SELECT signature,payload_hash,schema_activation_epoch FROM core.verification_attestations WHERE id=${attestationId}`;
      expect(after).toEqual(before);
    });

    it("keeps activation clocks visible only to live actors, read only and frozen after signing", async () => {
      const attestationId=await signOne();
      const own=await withActor(fx.appSql, { subjectId: fx.operatorSubjectA },async tx=>{
        const [role]=await tx`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
        expect(role).toMatchObject({rolsuper:false,rolbypassrls:false});
        return tx`SELECT * FROM core.schema_activation_clocks`;
      });
      expect(await withActor(fx.appSql, { subjectId: randomUUID() },tx=>tx`SELECT * FROM core.schema_activation_clocks`)).toEqual([]);
      expect(own.length).toBeGreaterThan(0);
      expect(await fx.appSql`SELECT * FROM core.schema_activation_clocks`).toEqual([]);
      await expect(withActor(fx.appSql, { subjectId: fx.operatorSubjectA },tx=>tx`UPDATE core.schema_activation_clocks SET epoch=epoch+1`)).rejects.toMatchObject({code:"42501"});
      await expect(withActor(fx.appSql, { subjectId: fx.operatorSubjectA },tx=>tx`INSERT INTO core.schema_activation_clocks(schema_key,epoch) VALUES('forged',999)`)).rejects.toMatchObject({code:"42501"});
      await expect(fx.sql`UPDATE core.verification_attestations SET schema_activation_epoch=schema_activation_epoch+1 WHERE id=${attestationId}`).rejects.toMatchObject({code:"42501"});
      await dispute(attestationId,{reasonCode:"X",detail:"Check source"});
      const [objection]=await disputeOf(attestationId);
      const restored=await resolve(objection!.id,{outcome:"dismissed",resolution:"Schema activation is unrelated"});
      expect(restored.statusCode,restored.body).toBe(200);expect(restored.json().attestationState).toBe("active");
    });

    it("blocks a resolver whose current credential belongs to the operator, including cached replays", async () => {
      const attestationId=await signOne();
      await dispute(attestationId,{reasonCode:"X",detail:"Check scope"});
      const [objection]=await disputeOf(attestationId), credential=randomUUID();
      await fx.sql`INSERT INTO core.credentials(id,subject_id,organization_id,issuer_reference,credential_type,issued_at,expires_at)
        VALUES(${credential},${resolverSubjectId},${fx.orgA},'Operator affiliation','competent_person',now()-interval '1 day',now()+interval '1 day')`;
      const body={outcome:"dismissed",resolution:"Review by an independent person"}, key=idempotencyKey();
      const denied=await resolve(objection!.id,body,resolverToken,key);
      expect(denied.statusCode,denied.body).toBe(403);
      expect(denied.json().code).toBe("DISPUTE_RESOLUTION_NOT_INDEPENDENT");
      expect((await disputeOf(attestationId))[0]!.resolvedAt).toBeNull();
      // Expiry is checked live even before a background job refreshes current_status.
      await fx.sql`UPDATE core.credentials SET expires_at=now()-interval '1 hour' WHERE id=${credential}`;
      expect((await resolve(objection!.id,body,resolverToken,key)).statusCode).toBe(200);
      await fx.sql`UPDATE core.credentials SET expires_at=now()+interval '1 day' WHERE id=${credential}`;
      expect((await resolve(objection!.id,body,resolverToken,key)).statusCode).toBe(403);
      await fx.sql`UPDATE core.credentials SET expires_at=now()-interval '1 hour' WHERE id=${credential}`;
    });

    it("a reviewer cannot resolve an objection they raised", async () => {
      const attestationId=await signOne();
      expect((await dispute(attestationId,{reasonCode:"X",detail:"Independent concern"},resolverToken)).statusCode).toBe(200);
      const [raised]=await disputeOf(attestationId);
      const denied=await resolve(raised!.id,{outcome:"dismissed",resolution:"Self dismissal"});
      expect(denied.statusCode,denied.body).toBe(403);
      expect(denied.json().code).toBe("DISPUTE_RESOLUTION_NOT_INDEPENDENT");
    });

    it.each([["upheld","dismissed"],["dismissed","upheld"]])("an upheld outcome outranks a later or earlier dismissal (%s then %s)", async (first,second) => {
      const attestationId=await signOne();
      await dispute(attestationId,{reasonCode:"A",detail:"First"});await dispute(attestationId,{reasonCode:"B",detail:"Second"});
      const raised=await disputeOf(attestationId);
      expect((await resolve(raised[0]!.id,{outcome:first,resolution:"Checked first"})).statusCode).toBe(200);
      const last=await resolve(raised[1]!.id,{outcome:second,resolution:"Checked second"});
      expect(last.statusCode,last.body).toBe(200);expect(last.json().attestationState).toBe("disputed");
      const [saved]=await fx.sql`SELECT state FROM core.verification_attestations WHERE id=${attestationId}`;expect(saved!.state).toBe("disputed");
    });

    it("leaves resolution pending while evidence is locked and retries with the same key", async () => {
      const attestationId=await signOne();
      await dispute(attestationId,{reasonCode:"X",detail:"Check source"});
      const [raised]=await disputeOf(attestationId), key=idempotencyKey(), body={outcome:"dismissed",resolution:"Checked"};
      const signingCase=await createCase(), draft=(await draftAttestation(signingCase.id,signingCase.assignmentId)).json();
      const request=(await requestSignature(draft.id)).json(), signingKey=idempotencyKey();
      const signature={signatureRequestId:request.signatureRequestId,signature:await signTypedData(request.typedData)};
      await fx.sql.begin(async hold=>{
        await hold`SELECT pg_advisory_xact_lock(hashtextextended(${`ledger-project:${fx.projectA}`},0))`;
        const busy=await resolve(raised!.id,body,resolverToken,key);
        expect(busy.statusCode,busy.body).toBe(503);expect(busy.json().code).toBe("DISPUTE_EVIDENCE_BUSY");
        expect((await disputeOf(attestationId))[0]!.resolvedAt).toBeNull();
        const signing=await submitSignature(draft.id,signature,reviewerToken,signingKey);
        expect(signing.statusCode,signing.body).toBe(503);expect(signing.json().code).toBe("ATTESTATION_EVIDENCE_BUSY");
      });
      expect((await resolve(raised!.id,body,resolverToken,key)).statusCode).toBe(200);
      expect((await submitSignature(draft.id,signature,reviewerToken,signingKey)).statusCode).toBe(200);
    });

    it("serializes issuer suspension against both restoration and final signing", async () => {
      const issuer=randomUUID(),credentialId=randomUUID();
      await fx.sql`INSERT INTO core.authorities SELECT (jsonb_populate_record(NULL::core.authorities,
        to_jsonb(a)||jsonb_build_object('id',${issuer}::text,'name',${`race-${issuer}`}::text))).* FROM core.authorities a WHERE id=${fx.issuerAuthorityA}`;
      await fx.sql`INSERT INTO core.credentials SELECT (jsonb_populate_record(NULL::core.credentials,
        to_jsonb(c)||jsonb_build_object('id',${credentialId}::text,'issuer_authority_id',${issuer}::text))).* FROM core.credentials c WHERE id=${fx.credentialA}`;
      expect(await fx.sql`SELECT id FROM core.source_connections WHERE authority_id=${issuer}`).toEqual([]);
      const claim=await app.inject({method:"POST",url:`/api/v1/projects/${fx.projectA}/claims`,
        headers:{authorization:`Bearer ${stewardToken}`,"idempotency-key":idempotencyKey()},
        payload:{claimType:"mining_right_registration",valueText:`Issuer ${issuer}`,sourceCoordinate:{document:"registry",page:"1"},evidenceTier:"P1"}});
      expect(claim.statusCode,claim.body).toBe(200);
      const evidenceClaimId=claim.json().id, attestationId=await signOne(evidenceClaimId,{credentialId});
      await dispute(attestationId,{reasonCode:"X",detail:"Check original evidence"});
      const [objection]=await disputeOf(attestationId), key=idempotencyKey(), body={outcome:"dismissed",resolution:"Finding checked"};
      const next=await createCase(evidenceClaimId,{credentialId});
      const draft=(await draftAttestation(next.id,next.assignmentId,{claimScope:[evidenceClaimId]})).json();
      const request=(await requestSignature(draft.id)).json(), signingKey=idempotencyKey();
      const signature={signatureRequestId:request.signatureRequestId,signature:await signTypedData(request.typedData)};
      await fx.sql.begin(async writer=>{
        await writer`UPDATE core.authorities SET state='suspended',state_reason='Issuer review' WHERE id=${issuer}`;
        const restoration=await resolve(objection!.id,body,resolverToken,key);
        expect(restoration.statusCode,restoration.body).toBe(503);expect(restoration.json().code).toBe("DISPUTE_EVIDENCE_BUSY");
        const signing=await submitSignature(draft.id,signature,reviewerToken,signingKey);
        expect(signing.statusCode,signing.body).toBe(503);expect(signing.json().code).toBe("ATTESTATION_EVIDENCE_BUSY");
        expect((await disputeOf(attestationId))[0]!.resolvedAt).toBeNull();
      });
      const restoration=await resolve(objection!.id,body,resolverToken,key);
      expect(restoration.statusCode,restoration.body).toBe(200);expect(restoration.json().attestationState).toBe("stale_candidate");
      const signing=await submitSignature(draft.id,signature,reviewerToken,signingKey);
      expect(signing.statusCode,signing.body).toBe(422);expect(signing.json().code).toBe("ATTESTATION_ACCEPTANCE_BLOCKED");
      const [standing]=await fx.sql`SELECT verification_state FROM core.claims WHERE id=${evidenceClaimId}`;
      expect(standing!.verification_state).toBe("unreviewed");
    });

    it("serializes operator-affiliation grants for the signer and dispute resolver", async () => {
      const created=await app.inject({method:"POST",url:`/api/v1/projects/${fx.projectA}/claims`,
        headers:{authorization:`Bearer ${stewardToken}`,"idempotency-key":idempotencyKey()},
        payload:{claimType:"mining_right_registration",valueText:"Affiliation race",sourceCoordinate:{page:"1"},evidenceTier:"P1"}});
      expect(created.statusCode,created.body).toBe(200);const evidenceClaimId=created.json().id;
      const attestationId=await signOne(evidenceClaimId);
      await dispute(attestationId,{reasonCode:"X",detail:"Check"});
      const [objection]=await disputeOf(attestationId), key=idempotencyKey(), body={outcome:"dismissed",resolution:"Finding checked"};
      const next=await createCase(evidenceClaimId), draft=(await draftAttestation(next.id,next.assignmentId,{claimScope:[evidenceClaimId]})).json();
      const request=(await requestSignature(draft.id)).json(), signingKey=idempotencyKey();
      const signature={signatureRequestId:request.signatureRequestId,signature:await signTypedData(request.typedData)};
      const signerGrant=randomUUID(),resolverGrant=randomUUID();
      try {
        await fx.sql.begin(async writer=>{
          await writer`INSERT INTO core.role_bindings(id,subject_id,organization_id,role)
            VALUES(${signerGrant},${fx.reviewerSubjectA},${fx.orgA},'project_member'),
              (${resolverGrant},${resolverSubjectId},${fx.orgA},'project_member')`;
          const signing=await submitSignature(draft.id,signature,reviewerToken,signingKey);
          expect(signing.statusCode,signing.body).toBe(503);expect(signing.json().code).toBe("ATTESTATION_EVIDENCE_BUSY");
          const resolution=await resolve(objection!.id,body,resolverToken,key);
          expect(resolution.statusCode,resolution.body).toBe(503);expect(resolution.json().code).toBe("DISPUTE_EVIDENCE_BUSY");
          expect((await disputeOf(attestationId))[0]!.resolvedAt).toBeNull();
        });
        const signing=await submitSignature(draft.id,signature,reviewerToken,signingKey);
        expect(signing.statusCode,signing.body).toBe(422);expect(signing.json().code).toBe("ATTESTATION_OPERATOR_NOT_INDEPENDENT");
        const resolution=await resolve(objection!.id,body,resolverToken,key);
        expect(resolution.statusCode,resolution.body).toBe(403);expect(resolution.json().code).toBe("DISPUTE_RESOLUTION_NOT_INDEPENDENT");
        expect((await disputeOf(attestationId))[0]!.resolvedAt).toBeNull();
        await fx.sql`UPDATE core.role_bindings SET revoked_at=now() WHERE id=${resolverGrant}`;
        const checked=await resolve(objection!.id,body,resolverToken,key);
        expect(checked.statusCode,checked.body).toBe(200);expect(checked.json().attestationState).toBe("stale_candidate");
        const [claim]=await fx.sql`SELECT verification_state FROM core.claims WHERE id=${evidenceClaimId}`;
        expect(claim!.verification_state).toBe("unreviewed");
      } finally {
        await fx.sql`UPDATE core.role_bindings SET revoked_at=now() WHERE id=ANY(${[signerGrant,resolverGrant]}::uuid[]) AND revoked_at IS NULL`;
      }
      expect((await submitSignature(draft.id,signature,reviewerToken,signingKey)).statusCode).toBe(200);
    });

    it("observes assignment revocation committed while final signing waits", async () => {
      const opened=await createCase(), drafted=(await draftAttestation(opened.id,opened.assignmentId)).json();
      const request=(await requestSignature(drafted.id)).json();
      const body={signatureRequestId:request.signatureRequestId,signature:await signTypedData(request.typedData)};
      let pending!:ReturnType<typeof submitSignature>;
      await fx.sql.begin(async writer=>{
        // Same row scope and lock order as the curator assignment-revocation route.
        await writer`SELECT asg.id FROM core.assignments asg JOIN core.verification_cases vc ON vc.id=asg.case_id
          WHERE asg.id=${opened.assignmentId} FOR UPDATE OF asg,vc`;
        await writer`UPDATE core.assignments SET revoked_at=now(),revoke_reason='Reviewer withdrawn' WHERE id=${opened.assignmentId}`;
        pending=submitSignature(drafted.id,body);
        const deadline=Date.now()+3000;let waiting=false;
        while(Date.now()<deadline) {
          const [row]=await fx.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%core.verification_%') AS waiting`;
          if(row!.waiting){waiting=true;break;}
          await new Promise(done=>setTimeout(done,10));
        }
        expect(waiting).toBe(true);
      });
      const denied=await pending;
      expect(denied.statusCode,denied.body).toBe(422);expect(denied.json().code).toBe("ATTESTATION_ACCEPTANCE_BLOCKED");
      const [saved]=await fx.sql`SELECT state,signature FROM core.verification_attestations WHERE id=${drafted.id}`;
      expect(saved).toMatchObject({state:"draft",signature:""});
    });

    it("does not resurrect a cancelled case using a previously issued signature request", async () => {
      const opened=await createCase(), drafted=(await draftAttestation(opened.id,opened.assignmentId)).json();
      const request=(await requestSignature(drafted.id)).json();
      const cancelled=await app.inject({method:"POST",url:`/api/v1/verification-cases/${opened.id}/transitions`,headers:{authorization:`Bearer ${stewardToken}`,"idempotency-key":idempotencyKey(),"if-match":'"2"'},payload:{toState:"cancelled",reason:"Curator withdrew this review"}});
      expect(cancelled.statusCode,cancelled.body).toBe(200);
      const denied=await submitSignature(drafted.id,{signatureRequestId:request.signatureRequestId,signature:await signTypedData(request.typedData)});
      expect(denied.statusCode,denied.body).toBe(422);expect(denied.json().code).toBe("ATTESTATION_ACCEPTANCE_BLOCKED");
      const [saved]=await fx.sql`SELECT state FROM core.verification_cases WHERE id=${opened.id}`;
      expect(saved!.state).toBe("cancelled");
    });

    it("concurrent dismissals serialize on their attestation and restore it exactly once", async () => {
      const attestationId=await signOne();
      await dispute(attestationId,{reasonCode:"A",detail:"First"});await dispute(attestationId,{reasonCode:"B",detail:"Second"});
      const raised=await disputeOf(attestationId);
      let pending!:Promise<Awaited<ReturnType<typeof resolve>>[]>;
      await fx.sql.begin(async hold=>{
        await hold`SELECT id FROM core.verification_attestations WHERE id=${attestationId} FOR UPDATE`;
        pending=Promise.all(raised.map(row=>resolve(row.id,{outcome:"dismissed",resolution:"Checked"})));
        const deadline=Date.now()+3000;
        while(Date.now()<deadline) {
          const [waiting]=await fx.sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF a%'`;
          if(waiting!.n>=2) return;
          await new Promise(done=>setTimeout(done,10));
        }
        throw new Error("Both dispute resolutions did not wait for their attestation lock");
      });
      const results=await pending;expect(results.map(r=>r.statusCode)).toEqual([200,200]);
      const [saved]=await fx.sql`SELECT state FROM core.verification_attestations WHERE id=${attestationId}`;expect(saved!.state).toBe("active");
    });

    it("dismissing restores the review to valid", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "please check" });
      const [raised] = await disputeOf(attestationId);

      const response = await resolve(raised!.id, {
        outcome: "dismissed",
        resolution: "checked, no issue",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().attestationState).toBe("active");
    });

    it("upholding does not restore the review to valid", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "evidence is wrong" });
      const [raised] = await disputeOf(attestationId);

      const response = await resolve(raised!.id, {
        outcome: "upheld",
        resolution: "the objection is correct",
      });

      // A review confirmed wrong cannot be marked valid. Supersede/revoke is a separate
      // decision.
      expect(response.json().attestationState).toBe("disputed");
    });

    it("stays disputed after a dismissal while other disputes remain", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "A", detail: "first" });
      await dispute(attestationId, { reasonCode: "B", detail: "second" });
      const raised = await disputeOf(attestationId);

      const response = await resolve(raised[0]!.id, {
        outcome: "dismissed",
        resolution: "this one is fine",
      });
      expect(response.json().attestationState).toBe("disputed");
      expect(response.json().unresolvedDisputes).toBe(1);
    });

    it("keeps the dispute record after resolution", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "please check" });
      const [raised] = await disputeOf(attestationId);
      await fx.sql`UPDATE core.verification_attestations SET state='stale_candidate' WHERE id=${attestationId}`;
      const resolved=await resolve(raised!.id, { outcome: "dismissed", resolution: "no issue" });
      expect(resolved.statusCode,resolved.body).toBe(200);
      expect(resolved.json().attestationState).toBe("stale_candidate");
      const [stored]=await fx.sql`SELECT state FROM core.verification_attestations WHERE id=${attestationId}`;
      expect(stored!.state).toBe("stale_candidate");

      const after = await disputeOf(attestationId);
      // Deleting it would erase the fact that "an issue was once raised".
      expect(after).toHaveLength(1);
      expect(after[0]!.resolvedAt).not.toBeNull();
    });

    it("cannot resolve without a resolution", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "please check" });
      const [raised] = await disputeOf(attestationId);

      const response = await resolve(raised!.id, { outcome: "dismissed", resolution: "" });
      expect(response.statusCode).toBe(400);
    });

    it("cannot resolve an already resolved dispute", async () => {
      const attestationId = await signOne();
      await dispute(attestationId, { reasonCode: "X", detail: "please check" });
      const [raised] = await disputeOf(attestationId);
      await resolve(raised!.id, { outcome: "dismissed", resolution: "no issue" });

      const again = await resolve(raised!.id, { outcome: "upheld", resolution: "reversal" });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("DISPUTE_ALREADY_RESOLVED");
    });

    it("cannot dispute an unsigned draft", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();

      // draft → disputed is not in the state machine. An unsigned item cannot be disputed.
      const response = await dispute(draft.id, { reasonCode: "X", detail: "not signed yet" });
      expect(response.statusCode).toBe(409);
    });
  });

  it("AC-01: cannot create a draft without limitations", async () => {
    const created = await createCase();
    const response = await draftAttestation(created.id, created.assignmentId, {
      limitations: "",
    });
    expect(response.statusCode).toBe(400);
  });

  it("AC-01: rejects whitespace-only limitations", async () => {
    const created = await createCase();
    const response = await draftAttestation(created.id, created.assignmentId, {
      limitations: "   ",
    });
    expect([400, 422]).toContain(response.statusCode);
  });

  it("completes the normal signing flow", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    expect(draft.state).toBe("draft");

    const signatureRequest = (await requestSignature(draft.id)).json();
    expect(signatureRequest.humanReadablePayload).toContain("Review scope and limitations");
    expect(signatureRequest.humanReadablePayload).toContain("does not guarantee factual accuracy");

    const signature = await signTypedData(signatureRequest.typedData);
    const submitted = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().state).toBe("signed");
    expect(submitted.json().signerWalletAddress).toBe(reviewerAccount.address.toLowerCase());
  });

  it("a signature request is single-use", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);

    const first = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });
    expect(first.statusCode).toBe(200);

    const replay = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe("SIGNATURE_REQUEST_UNUSABLE");
  });

  it("rejects a signature from someone else", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData, outsiderAccount);

    const response = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("SIGNATURE_SIGNER_MISMATCH");
  });

  it("freezes the evidence manifest and hash after requesting a signature", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();

    await expect(fx.sql`
      UPDATE core.verification_cases SET evidence_snapshot_hash = ${"0x" + "ff".repeat(32)}
      WHERE id = ${created.id}
    `).rejects.toThrow("immutable");
    await expect(fx.sql`
      UPDATE core.verification_cases SET evidence_snapshot = NULL WHERE id = ${created.id}
    `).rejects.toThrow("immutable");

    const signature = await signTypedData(signatureRequest.typedData);
    const response = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  it("cannot modify the body after signing", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);
    await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    await expect(
      fx.sql`
        UPDATE core.verification_attestations SET limitations = 'modified' WHERE id = ${draft.id}
      `,
    ).rejects.toThrow(/cannot be modified/);
  });

  it("cannot create a new signature request for a signed attestation", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);
    await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    const again = await requestSignature(draft.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("ATTESTATION_ALREADY_SIGNED");
  });

  it("cannot create a draft with an unresolved conflict of interest", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: fx.schemaA,
        claimIds: [claimId],
        reviewerSubjectId: fx.reviewerSubjectA,
        credentialId: fx.credentialA,
        conflictStatus: "unresolved",
      },
    });
    const created = response.json();

    const draft = await draftAttestation(created.id, created.assignmentId);
    expect(draft.statusCode).toBe(403);
  });

  it("non-reviewers cannot create a draft", async () => {
    const created = await createCase();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/verification-cases/${created.id}/attestations`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        assignmentId: created.assignmentId,
        attestationType: "professional_signoff",
        claimScope: [claimId],
        limitations: "scope limited",
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("cannot create a draft on someone else's assignment", async () => {
    /**
     * A role check does not block this path: all reviewers share the same role.
     * Without matching the assignee, findings are recorded under someone else's name.
     */
    const created = await createCase();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/verification-cases/${created.id}/attestations`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        assignmentId: created.assignmentId,
        attestationType: "professional_signoff",
        claimScope: [claimId],
        findings: [{ note: "someone else's assignment" }],
        citations: [{ source: "registry-extract" }],
        limitations: "scope limited",
      },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe("ASSIGNMENT_NOT_OWNED");
  });

  /**
   * Signature requests carry the same checks as drafting.
   *
   * The response holds the typed data and the human-readable payload of the draft — project key,
   * type, claim count, limitations, snapshot hash. Without these checks anyone in the Registry
   * could read another project's draft and create request rows against it.
   */
  describe("signature request authorization", () => {
    async function requestSignatureAs(token: string, attestationId: string) {
      return app.inject({
        method: "POST",
        url: `/api/v1/attestations/${attestationId}/signature-requests`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
    }

    async function requestRowCount(attestationId: string): Promise<number> {
      const [row] = await fx.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM core.attestation_signature_requests
        WHERE attestation_id = ${attestationId}
      `;
      return Number(row!.count);
    }

    /** A reviewer whose only binding is on another project. */
    async function otherProjectReviewerToken(): Promise<string> {
      const account = newAccount();
      const subject = randomUUID();
      await fx.sql`
        INSERT INTO core.subjects (id, kind, display_name)
        VALUES (${subject}, 'person', 'Other Project Reviewer')
      `;
      await fx.sql`
        INSERT INTO core.wallet_identities (
          id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          ${randomUUID()}, ${subject}, ${account.address}, 31337, 'high_assurance', now()
        )
      `;
      await syncSubjectAssurance(fx.sql);
      await fx.sql`
        INSERT INTO core.role_bindings (
          id, subject_id, organization_id, project_id, role
        ) VALUES (
          ${randomUUID()}, ${subject}, ${fx.orgA}, ${fx.otherProjectA}, 'reviewer'
        )
      `;
      return signIn(app, account);
    }

    it("rejects a user of another project", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();

      const response = await requestSignatureAs(await otherProjectReviewerToken(), draft.id);

      // The draft's project is outside the reviewer's binding: hidden, not found.
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("typedData");
      expect(await requestRowCount(draft.id)).toBe(0);
    });

    it("rejects a subject that is not the assignee", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();

      // Same organization-level role — still not the assigned reviewer.
      const response = await requestSignatureAs(stewardToken, draft.id);

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("ASSIGNMENT_NOT_OWNED");
      expect(response.body).not.toContain("humanReadablePayload");
      expect(await requestRowCount(draft.id)).toBe(0);
    });

    it("still issues the request to the assigned reviewer", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();

      const response = await requestSignatureAs(reviewerToken, draft.id);

      expect(response.statusCode).toBe(200);
      expect(response.json().typedData).toBeDefined();
      expect(await requestRowCount(draft.id)).toBe(1);
    });

    it("does not hand the stored response to another user replaying the assignee's key", async () => {
      // An idempotency key is unique across the Registry and the body here is empty, so a replay
      // finds the stored key. The checks must run before the stored response is returned.
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();
      const key = idempotencyKey();
      const send = (token: string) =>
        app.inject({
          method: "POST",
          url: `/api/v1/attestations/${draft.id}/signature-requests`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: {},
        });

      expect((await send(reviewerToken)).statusCode).toBe(200);
      const replayed = await send(stewardToken);

      expect(replayed.statusCode).toBe(403);
      expect(replayed.body).not.toContain("typedData");
      expect(await requestRowCount(draft.id)).toBe(1);
    });
  });

  it("signing writes audit and outbox records", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();
    const signature = await signTypedData(signatureRequest.typedData);
    await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    const audits = await fx.sql<{ command: string }[]>`
      SELECT command FROM audit.events WHERE resource_id = ${draft.id} ORDER BY id
    `;
    expect(audits.map((row) => row.command)).toContain("verification.case.signed");

    const events = await fx.sql<{ event_type: string }[]>`
      SELECT event_type FROM core.outbox WHERE aggregate_id = ${draft.id}
    `;
    expect(events.map((row) => row.event_type)).toContain("verification_attestation.signed");
  });

  describe("live reviewer authority for relayed signatures", () => {
    async function pending() {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();
      const requested = await requestSignature(draft.id);
      expect(requested.statusCode, requested.body).toBe(200);
      const signatureRequest = requested.json();
      return {
        attestationId: draft.id as string,
        body: {
          signatureRequestId: signatureRequest.signatureRequestId,
          signature: await signTypedData(signatureRequest.typedData),
        },
      };
    }

    async function expectPending(attestationId: string, signatureRequestId: string) {
      const [request] = await fx.sql`SELECT consumed_at FROM core.attestation_signature_requests WHERE id = ${signatureRequestId}`;
      expect(request!.consumed_at).toBeNull();
      const [attestation] = await fx.sql`SELECT state, signature FROM core.verification_attestations WHERE id = ${attestationId}`;
      expect(attestation).toMatchObject({ state: "draft", signature: "" });
      const [count] = await fx.sql`SELECT count(*)::int AS n FROM audit.events WHERE command = 'verification.case.signed' AND resource_id = ${attestationId}`;
      expect(count!.n).toBe(0);
    }

    async function waitForBlocked(fragment: string) {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const [waiting] = await fx.sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE ${`%${fragment}%`} LIMIT 1
        `;
        if (waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No database lock wait observed for ${fragment}`);
    }

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    }

    it("permits an active in-reach relay and refuses another company without consuming its request", async () => {
      const prepared = await pending();
      const otherCompany = await signIn(app, fx.operatorB);
      const denied = await submitSignature(prepared.attestationId, prepared.body, otherCompany);
      expect(denied.statusCode, denied.body).toBe(409);
      expect(denied.json().code).toBe("SIGNATURE_REQUEST_UNUSABLE");
      await expectPending(prepared.attestationId, prepared.body.signatureRequestId);
      const accepted = await submitSignature(prepared.attestationId, prepared.body, stewardToken);
      expect(accepted.statusCode, accepted.body).toBe(200);
      const [record] = await fx.sql`SELECT actor_subject_id, actor_wallet FROM audit.events WHERE command = 'verification.case.signed' AND resource_id = ${prepared.attestationId}`;
      expect(record).toMatchObject({ actor_subject_id: fx.stewardSubjectA, actor_wallet: reviewerWallet });
    });

    it("refuses a suspended reviewer behind an active relay and preserves the request for reinstatement", async () => {
      const prepared = await pending();
      const key = idempotencyKey();
      await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${fx.reviewerSubjectA}`;
      try {
        const denied = await submitSignature(prepared.attestationId, prepared.body, stewardToken, key);
        expect(denied.statusCode, denied.body).toBe(422);
        expect(denied.json().code).toBe("SUBJECT_SUSPENDED");
        await expectPending(prepared.attestationId, prepared.body.signatureRequestId);
      } finally {
        await fx.sql`UPDATE core.subjects SET suspended_at = NULL WHERE id = ${fx.reviewerSubjectA}`;
      }
      const retried = await submitSignature(prepared.attestationId, prepared.body, stewardToken, key);
      expect(retried.statusCode, retried.body).toBe(200);
    });

    it("waits for a concurrent suspension and refuses its now-suspended signer", async () => {
      const prepared = await pending();
      const locked = deferred();
      const release = deferred();
      const suspension = fx.sql.begin(async (tx) => {
        await tx`UPDATE core.subjects SET suspended_at = now() WHERE id = ${fx.reviewerSubjectA}`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      let submitted: ReturnType<typeof submitSignature> | undefined;
      try {
        submitted = submitSignature(prepared.attestationId, prepared.body, stewardToken);
        await waitForBlocked("SELECT suspended_at FROM core.subjects");
        release.resolve();
        await suspension;
        const denied = await submitted;
        expect(denied.statusCode, denied.body).toBe(422);
        expect(denied.json().code).toBe("SUBJECT_SUSPENDED");
        await expectPending(prepared.attestationId, prepared.body.signatureRequestId);
      } finally {
        release.resolve();
        await suspension;
        if (submitted) await submitted;
        await fx.sql`UPDATE core.subjects SET suspended_at = NULL WHERE id = ${fx.reviewerSubjectA}`;
      }
    });

    it("observes suspension committed while waiting for the attestation lock", async () => {
      const prepared = await pending();
      const locked = deferred();
      const release = deferred();
      const heldAttestation = fx.sql.begin(async (tx) => {
        await tx`SELECT id FROM core.verification_attestations WHERE id = ${prepared.attestationId} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      let submitted: ReturnType<typeof submitSignature> | undefined;
      let suspension: Promise<unknown> | undefined;
      try {
        submitted = submitSignature(prepared.attestationId, prepared.body, stewardToken);
        await waitForBlocked("FOR UPDATE OF a, asg, vc");
        suspension = fx.sql.begin(async (tx) => {
          await tx`UPDATE core.subjects SET suspended_at = now() WHERE id = ${fx.reviewerSubjectA}`;
        });
        await suspension;
        release.resolve();
        await heldAttestation;
        const accepted = await submitted;
        expect(accepted.statusCode, accepted.body).toBe(422);
        expect(accepted.json().code).toBe("SUBJECT_SUSPENDED");
        await expectPending(prepared.attestationId, prepared.body.signatureRequestId);
        await suspension;
        const [signed] = await fx.sql`SELECT state, signature, signer_wallet_address FROM core.verification_attestations WHERE id = ${prepared.attestationId}`;
        expect(signed).toMatchObject({ state: "draft", signature: "", signer_wallet_address: "0x0000000000000000000000000000000000000000" });
        const [subject] = await fx.sql`SELECT suspended_at FROM core.subjects WHERE id = ${fx.reviewerSubjectA}`;
        expect(subject!.suspended_at).not.toBeNull();
      } finally {
        release.resolve();
        await heldAttestation;
        if (submitted) await submitted;
        if (suspension) await suspension;
        await fx.sql`UPDATE core.subjects SET suspended_at = NULL WHERE id = ${fx.reviewerSubjectA}`;
      }
    });
  });

  /**
   * A reviewer holds one signing wallet at a time (0130). The signer must be the assigned
   * reviewer's active wallet — not the wallet the session signed in with, which an account
   * session does not have. A replace moves signing to the new key at once; attestations the old
   * key signed stay attributed to it. Runs last in this file: it replaces the reviewer's wallet.
   */
  describe("signing with the reviewer's active wallet, across a replace", () => {
    const second = privateKeyToAccount(generatePrivateKey());
    let beforeReplace: string;
    let oldWalletId: string;

    beforeAll(async () => {
      const signed = await signedWith(reviewerAccount);
      expect(signed.response.statusCode, signed.response.body).toBe(200);
      beforeReplace = signed.draftId;

      // Passkey: the reviewer holds one (`signIn` sessions prove it), and binding needs the
      // strongest factor held (WP5). `reviewerToken` must survive: a replace keeps sessions.
      const account = await issueTestSession(fx.appSql, fx.reviewerSubjectA, {
        firstFactor: "email_code",
        secondFactor: "passkey",
      });
      const bound = await bindWalletByProof(app, account, second, "rotation", reviewerAccount);
      expect(bound.statusCode, bound.body).toBe(200);
      expect(bound.json().replaced).toMatchObject({ walletAddress: reviewerWallet });
      oldWalletId = bound.json().replaced.id;

      // The replaced wallet was operator-verified, so the reviewer fell to the floor and an admin
      // verifies them again before they sign (0130).
      const [level] = await fx.sql<{ assurance_level: string }[]>`
        SELECT assurance_level::text FROM core.subjects WHERE id = ${fx.reviewerSubjectA}
      `;
      expect(level!.assurance_level).toBe("wallet_only");
      const verified = await app.inject({
        method: "POST",
        url: `/api/v1/admin/subjects/${fx.reviewerSubjectA}/assurance`,
        headers: { authorization: `Bearer ${await signIn(app, fx.operatorA)}`, "idempotency-key": idempotencyKey() },
        payload: { assuranceLevel: "high_assurance", justification: "re-verified after the wallet replace" },
      });
      expect(verified.statusCode, verified.body).toBe(200);
    });

    async function signedWith(account: ReturnType<typeof privateKeyToAccount>) {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();
      const signatureRequest = (await requestSignature(draft.id)).json();
      const signature = await signTypedData(signatureRequest.typedData, account);
      return {
        draftId: draft.id as string,
        response: await submitSignature(draft.id, { signatureRequestId: signatureRequest.signatureRequestId, signature }),
      };
    }

    it("a draft names no signer until it is signed", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();
      const [row] = await fx.sql<{ signer_wallet_address: string }[]>`
        SELECT signer_wallet_address FROM core.verification_attestations WHERE id = ${draft.id}
      `;
      expect(row!.signer_wallet_address).toBe(`0x${"0".repeat(40)}`);
    });

    it("refuses the replaced key, and keeps what it signed attributed to it and the reviewer", async () => {
      const { response } = await signedWith(reviewerAccount);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("SIGNATURE_SIGNER_MISMATCH");

      const [row] = await fx.sql<{ signer_wallet_address: string; state: string }[]>`
        SELECT signer_wallet_address, state FROM core.verification_attestations WHERE id = ${beforeReplace}
      `;
      expect(row!.signer_wallet_address).toBe(reviewerWallet);
      const [event] = await fx.sql<{ actor_wallet: string | null; actor_subject_id: string }[]>`
        SELECT actor_wallet, actor_subject_id FROM audit.events
        WHERE resource_id = ${beforeReplace} AND command = 'verification.case.signed'
      `;
      expect(event).toEqual({ actor_wallet: reviewerWallet, actor_subject_id: fx.reviewerSubjectA });
      // The old wallet row is history: still the reviewer's, disabled because it was replaced.
      const [wallet] = await fx.sql<{ subject_id: string; disabled: boolean; reason_code: string }[]>`
        SELECT w.subject_id, w.disabled_at IS NOT NULL AS disabled, e.reason_code
        FROM core.wallet_identities w JOIN core.wallet_disable_events e ON e.wallet_identity_id = w.id
        WHERE w.id = ${oldWalletId}
      `;
      expect(wallet).toEqual({ subject_id: fx.reviewerSubjectA, disabled: true, reason_code: "replaced" });
    });

    it("accepts the reviewer's new wallet and records it as the signer", async () => {
      const { draftId, response } = await signedWith(second);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().signerWalletAddress).toBe(second.address.toLowerCase());

      const [event] = await fx.sql<{ actor_wallet: string | null }[]>`
        SELECT actor_wallet FROM audit.events
        WHERE resource_id = ${draftId} AND command = 'verification.case.signed'
      `;
      expect(event!.actor_wallet).toBe(second.address.toLowerCase());
      const [row] = await fx.sql<{ signer_wallet_address: string }[]>`
        SELECT signer_wallet_address FROM core.verification_attestations WHERE id = ${draftId}
      `;
      expect(row!.signer_wallet_address).toBe(second.address.toLowerCase());
    });

    it("refuses an active wallet of another subject", async () => {
      const { response } = await signedWith(fx.stewardA.account);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("SIGNATURE_SIGNER_MISMATCH");
    });

    /**
     * A Google session carries no wallet at all (WP4). Signing must not lean on
     * one: the reviewer requests and submits from that session and the recovered key decides.
     */
    it("signs from a Google + passkey session with the reviewer's new wallet", async () => {
      const google = await issueTestSession(fx.appSql, fx.reviewerSubjectA, {
        firstFactor: "google",
        secondFactor: "passkey",
      });
      const view = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { authorization: `Bearer ${google}` } });
      expect(view.json()).toMatchObject({ authenticated: true, aal: "aal3" });
      expect(view.json().walletAddress ?? null).toBeNull();

      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();
      const headers = { authorization: `Bearer ${google}`, "idempotency-key": idempotencyKey() };
      const requested = await app.inject({
        method: "POST",
        url: `/api/v1/attestations/${draft.id}/signature-requests`,
        headers,
        payload: {},
      });
      expect(requested.statusCode, requested.body).toBe(200);
      const signature = await signTypedData(requested.json().typedData, second);
      const submitted = await app.inject({
        method: "POST",
        url: `/api/v1/attestations/${draft.id}/signatures`,
        headers: { authorization: `Bearer ${google}`, "idempotency-key": idempotencyKey() },
        payload: { signatureRequestId: requested.json().signatureRequestId, signature },
      });
      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().signerWalletAddress).toBe(second.address.toLowerCase());

      const [event] = await fx.sql<{ actor_wallet: string | null; actor_subject_id: string }[]>`
        SELECT actor_wallet, actor_subject_id FROM audit.events
        WHERE resource_id = ${draft.id} AND command = 'verification.case.signed'
      `;
      expect(event).toEqual({ actor_wallet: second.address.toLowerCase(), actor_subject_id: fx.reviewerSubjectA });
    });
  });
});
