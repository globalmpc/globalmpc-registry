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

  async function createCase() {
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
        conflictStatus: "none",
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

  it("does not list cases of another tenant", async () => {
    await createCase();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/verification-cases`,
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });

    // An empty list, not a permission error. For tenant B, projectA does not exist.
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
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
    async function signOne() {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();
      const signatureRequest = (await requestSignature(draft.id)).json();
      const signature = await signTypedData(signatureRequest.typedData);
      await submitSignature(draft.id, {
        signatureRequestId: signatureRequest.signatureRequestId,
        signature,
      });
      return draft.id as string;
    }

    function dispute(attestationId: string, body: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/api/v1/attestations/${attestationId}/disputes`,
        headers: {
          authorization: `Bearer ${stewardToken}`,
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

    function resolve(disputeId: string, body: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/api/v1/disputes/${disputeId}/resolution`,
        headers: {
          authorization: `Bearer ${stewardToken}`,
          "idempotency-key": idempotencyKey(),
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
      await resolve(raised!.id, { outcome: "dismissed", resolution: "no issue" });

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

  it("invalidates the signature request when evidence changes", async () => {
    const created = await createCase();
    const draft = (await draftAttestation(created.id, created.assignmentId)).json();
    const signatureRequest = (await requestSignature(draft.id)).json();

    // Changes evidence after the request.
    await fx.sql`
      UPDATE core.verification_cases
      SET evidence_snapshot_hash = ${"0x" + "ff".repeat(32)}
      WHERE id = ${created.id}
    `;

    const signature = await signTypedData(signatureRequest.typedData);
    const response = await submitSignature(draft.id, {
      signatureRequestId: signatureRequest.signatureRequestId,
      signature,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("EVIDENCE_SNAPSHOT_CHANGED");
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
     * A role check does not block this path: all reviewers in a tenant share the same role.
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
   * type, claim count, limitations, snapshot hash. Without these checks anyone in the tenant
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

    /** A reviewer whose only binding is on another project in the same tenant. */
    async function otherProjectReviewerToken(): Promise<string> {
      const account = newAccount();
      const subject = randomUUID();
      await fx.sql`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name)
        VALUES (${subject}, ${fx.tenantA}, 'person', 'Other Project Reviewer')
      `;
      await fx.sql`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${subject}, ${account.address}, 31337, 'high_assurance', now()
        )
      `;
      await syncSubjectAssurance(fx.sql);
      await fx.sql`
        INSERT INTO core.role_bindings (
          id, tenant_id, subject_id, organization_id, project_id, role
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, ${fx.otherProjectA}, 'reviewer_cp_qp'
        )
      `;
      return signIn(app, account);
    }

    it("rejects a user of another project", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();

      const response = await requestSignatureAs(await otherProjectReviewerToken(), draft.id);

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("typedData");
      expect(await requestRowCount(draft.id)).toBe(0);
    });

    it("rejects a subject that is not the assignee", async () => {
      const created = await createCase();
      const draft = (await draftAttestation(created.id, created.assignmentId)).json();

      // Same tenant, organization-level role — still not the assigned reviewer.
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
      // An idempotency key is scoped to the tenant and the body here is empty, so a replay
      // matches. The checks must run before the stored response is returned.
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

    it("permits an active same-tenant relay and refuses another tenant without consuming its request", async () => {
      const prepared = await pending();
      const otherTenant = await signIn(app, fx.operatorB);
      const denied = await submitSignature(prepared.attestationId, prepared.body, otherTenant);
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

    it("finishes an already-locked acceptance before suspension and preserves that signed history", async () => {
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
        await waitForBlocked("UPDATE core.verification_attestations");
        suspension = fx.sql.begin(async (tx) => {
          await tx`UPDATE core.subjects SET suspended_at = now() WHERE id = ${fx.reviewerSubjectA}`;
        });
        await waitForBlocked("UPDATE core.subjects SET suspended_at");
        release.resolve();
        await heldAttestation;
        const accepted = await submitted;
        expect(accepted.statusCode, accepted.body).toBe(200);
        await suspension;
        const [signed] = await fx.sql`SELECT state, signature, signer_wallet_address FROM core.verification_attestations WHERE id = ${prepared.attestationId}`;
        expect(signed).toMatchObject({ state: "signed", signature: prepared.body.signature, signer_wallet_address: reviewerWallet });
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
      const account = await issueTestSession(fx.appSql, fx.tenantA, fx.reviewerSubjectA, {
        firstFactor: "email_code",
        secondFactor: "passkey",
      });
      const bound = await bindWalletByProof(app, account, second);
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
     * A Google (or Microsoft) session carries no wallet at all (WP4). Signing must not lean on
     * one: the reviewer requests and submits from that session and the recovered key decides.
     */
    it("signs from a Google + passkey session with the reviewer's new wallet", async () => {
      const google = await issueTestSession(fx.appSql, fx.tenantA, fx.reviewerSubjectA, {
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
