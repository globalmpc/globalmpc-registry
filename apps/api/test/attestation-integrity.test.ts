import postgres from "postgres";
import { listMigrations, runMigrations } from "@mpc/db";
import { loadEvidenceSubmitters } from "../src/services/attestation-basis.js";
import { buildEvidenceSnapshot } from "../src/services/evidence-snapshot.js";
import { buildTypedData, uuidToBytes32, newSignatureNonce } from "../src/services/attestation-signing.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };
import { decideSigned, requestGateDecisionSignature, submitGateDecision } from "./helpers/gate-decision.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { collectRequirementFacts } from "../src/routes/readiness.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  type TestFixture, syncSubjectAssurance } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Attestation integrity — spec 02 §2.4·§2.6·§2.8, 04 §4.2, 05 §5.3, 07 §7.2, 13 AC-15·AC-16·AC-17,
 * REQ-DAPP-004·006·018·037·042·044·046.
 *
 * What is being signed over, by whom, on what basis, and how the record is corrected — every
 * correction a new fact, none an edit.
 */

interface Person {
  readonly account: TestAccount;
  readonly subjectId: string;
  readonly token: string;
}

interface Json {
  [key: string]: unknown;
}

describeDb("attestation integrity", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let steward: string;
  let reviewer: Person;
  /** reviewer — the registry approver role that verifies credentials (02 §2.8). */
  let verifier: Person;
  let secondVerifier: Person;
  let securityOperator: Person;

  async function addPerson(role: string, organizationId: string): Promise<Person> {
    const account = newAccount();
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', ${`${role} ${subjectId.slice(0, 4)}`})
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${account.address}, 31337, 'high_assurance', now()
      )
    `;
    await syncSubjectAssurance(fx.sql);
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${organizationId}, ${role})
    `;
    return { account, subjectId, token: await signIn(app, account) };
  }

  async function addIssuer(
    state = "accepted",
    scope: readonly string[] = ["mining_right_registration", "resource_estimate"],
  ): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove, recognized_scope,
        verification_method, public_disclosure_level, valid_from, state, state_reason
      ) VALUES (
        ${id}, ${fx.tenantA}, ${`Issuer ${id.slice(0, 6)}`}, 'AUS', ARRAY['member_competence'],
        ARRAY['opinion_accuracy'], ${scope as string[]}, 'verifiable_signed_document', 'public',
        '2000-01-01', ${state}, ${state === "suspended" ? "fixture" : null}
      )
    `;
    return id;
  }

  async function addCredential(
    subjectId: string,
    organizationId: string | null,
    issuerAuthorityId: string | null,
    scope: readonly string[] = ["mining_right_registration", "resource_estimate"],
  ): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.credentials (
        id, tenant_id, subject_id, organization_id, issuer_reference, issuer_authority_id,
        credential_type, credential_scope, jurisdiction, issued_at, expires_at, current_status
      ) VALUES (
        ${id}, ${fx.tenantA}, ${subjectId}, ${organizationId}, ${`CP #${id.slice(0, 6)}`},
        ${issuerAuthorityId}, 'competent_person', ${scope as string[]}, ARRAY['MNG'],
        now() - interval '1 year', now() + interval '1 year', 'valid'
      )
    `;
    return id;
  }

  async function createClaim(claimType = "mining_right_registration", projectId = fx.projectA, extra: Record<string,unknown> = {}): Promise<Json> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: { ...bearer(steward), "idempotency-key": idempotencyKey() },
      payload: {
        claimType,
        valueText: `MV-${randomUUID().slice(0, 6)}`,
        sourceCoordinate: { document: "extract", page: "1" },
        evidenceTier: "P1",
        ...extra,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Json;
  }

  function createCase(
    claimIds: readonly string[],
    reviewerSubjectId = fx.reviewerSubjectA,
    credentialId = fx.credentialA,
    token = steward,
    projectId = fx.projectA,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: {
        projectId,
        schemaId: fx.schemaA,
        claimIds,
        reviewerSubjectId,
        credentialId,
        conflictStatus: "none",
      },
    });
  }

  async function openCase(claimIds: readonly string[], projectId = fx.projectA): Promise<{ id: string; assignmentId: string }> {
    const response = await createCase(claimIds, fx.reviewerSubjectA, fx.credentialA, steward, projectId);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; assignmentId: string };
  }

  function draft(
    caseId: string,
    assignmentId: string,
    claimScope: readonly string[],
    overrides: Record<string, unknown> = {},
    token = reviewer.token,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/verification-cases/${caseId}/attestations`,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: {
        assignmentId,
        attestationType: "professional_signoff",
        claimScope,
        findings: [{ note: "registration checked" }],
        citations: [{ source: "registry-extract" }],
        limitations: "Registration status only; completeness of rights not confirmed",
        ...overrides,
      },
    });
  }

  function requestSignature(attestationId: string, token = reviewer.token) {
    return app.inject({
      method: "POST",
      url: `/api/v1/attestations/${attestationId}/signature-requests`,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: {},
    });
  }

  async function submit(attestationId: string, signatureRequest: Json, signer = reviewer) {
    const typedData = signatureRequest["typedData"] as {
      domain: unknown;
      types: unknown;
      primaryType: string;
      message: Record<string, unknown>;
    };
    const signature = await signer.account.account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        ...typedData.message,
        issuedAt: BigInt(typedData.message["issuedAt"] as string),
        expiresAt: BigInt(typedData.message["expiresAt"] as string),
      },
    } as unknown as Parameters<TestAccount["account"]["signTypedData"]>[0]);

    return app.inject({
      method: "POST",
      url: `/api/v1/attestations/${attestationId}/signatures`,
      headers: { ...bearer(signer.token), "idempotency-key": idempotencyKey() },
      payload: { signatureRequestId: signatureRequest["signatureRequestId"], signature },
    });
  }

  /** Case → draft → signature, returning the signed attestation id. */
  async function signOver(claimIds: readonly string[], overrides: Record<string, unknown> = {}, projectId = fx.projectA) {
    const opened = await openCase(claimIds, projectId);
    const drafted = await draft(opened.id, opened.assignmentId, claimIds, overrides);
    expect(drafted.statusCode, drafted.body).toBe(200);
    const attestationId = (drafted.json() as { id: string }).id;
    const request = (await requestSignature(attestationId)).json() as Json;
    const submitted = await submit(attestationId, request);
    expect(submitted.statusCode, submitted.body).toBe(200);
    return { caseId: opened.id, attestationId, submitted: submitted.json() as Json };
  }

  function revokeAttestation(attestationId: string, token = reviewer.token, reason = "Scope was misread") {
    return app.inject({
      method: "POST",
      url: `/api/v1/attestations/${attestationId}/revoke`,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: { reason },
    });
  }

  async function claimRow(claimId: string) {
    const [row] = await fx.sql<
      { verification_state: string; grade: string; value_text: string; version: number }[]
    >`
      SELECT verification_state, grade, value_text, version FROM core.claims WHERE id = ${claimId}
    `;
    return row!;
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    steward = await signIn(app, fx.stewardA);
    reviewer = {
      account: fx.reviewerA,
      subjectId: fx.reviewerSubjectA,
      token: await signIn(app, fx.reviewerA),
    };
    verifier = await addPerson("reviewer", fx.reviewOrgA);
    secondVerifier = await addPerson("reviewer", fx.reviewOrgA);
    securityOperator = await addPerson("administrator", fx.orgA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  // --- REQ-DAPP-037·046: versions in force --------------------------------

  describe("recorded method and policy versions", () => {
    it("records the schema version in force and says when no policy is effective", async () => {
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);
      const drafted = await draft(opened.id, opened.assignmentId, [claim["id"] as string]);
      expect(drafted.statusCode, drafted.body).toBe(200);

      const [row] = await fx.sql<{ method_version: string; policy_version: string }[]>`
        SELECT method_version, policy_version FROM core.verification_attestations
        WHERE id = ${drafted.json().id}
      `;
      // Not the literal '1', '1' it used to be.
      expect(row).toEqual({ method_version: "mining-right-review@1", policy_version: "none_effective" });
    });

    it("records, at signing, the policy sets effective for the schema's jurisdiction", async () => {
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);
      const drafted = (await draft(opened.id, opened.assignmentId, [claim["id"] as string])).json();

      // A policy becomes effective between the draft and the signature. The record is as of signing.
      await fx.sql`
        INSERT INTO core.compliance_policy_sets (
          id, tenant_id, rule_set_id, rule_set_version, gate_id, jurisdiction_profile,
          effective_from, definition, state
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, 'registry-publication-gate', '2.1.0',
          'registry_publication', 'MNG', now() - interval '1 day', '{}'::jsonb, 'effective'
        )
      `;
      const request = (await requestSignature(drafted.id)).json() as Json;
      const submitted = await submit(drafted.id, request);
      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().policyVersion).toBe("registry-publication-gate@2.1.0");

      const [row] = await fx.sql<{ policy_version: string; credential_status_snapshot: Json }[]>`
        SELECT policy_version, credential_status_snapshot FROM core.verification_attestations
        WHERE id = ${drafted.id}
      `;
      expect(row!.policy_version).toBe("registry-publication-gate@2.1.0");
      expect(row!.credential_status_snapshot).toMatchObject({
        statusAtSigning: "valid",
        validAtAttestationTime: true,
      });
    });
  });

  // --- 02 §2.4 rules 1·2: independence ------------------------------------

  describe("assignment independence", () => {
    it("records a checked assignment as reviewed, with what was compared", async () => {
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);

      const [row] = await fx.sql<{ independence_reviewed: boolean; independence_basis: Json; assigned_by: string }[]>`
        SELECT independence_reviewed, independence_basis, assigned_by FROM core.assignments
        WHERE id = ${opened.assignmentId}
      `;
      expect(row!.independence_reviewed).toBe(true);
      expect(row!.assigned_by).toBe(fx.stewardSubjectA);
      expect(row!.independence_basis).toMatchObject({
        evidenceSubmitterIds: [fx.stewardSubjectA],
        reviewerOrganizationIds: [fx.reviewOrgA],
        operatorOrganizationIds: [fx.orgA],
        violations: [],
        gaps: [],
      });
    });

    it("rule 1: refuses a reviewer who submitted the evidence", async () => {
      const claimId = randomUUID();
      await fx.sql`
        INSERT INTO core.claims (
          id, tenant_id, project_id, claim_type, value_text, source_coordinate, evidence_tier,
          submitted_by
        ) VALUES (
          ${claimId}, ${fx.tenantA}, ${fx.projectA}, 'mining_right_registration', 'MV-SELF',
          '{"page":"1"}', 'P1', ${fx.reviewerSubjectA}
        )
      `;
      const response = await createCase([claimId]);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ASSIGNMENT_INDEPENDENCE_VIOLATION");
      expect(response.json().details.violations).toEqual(["REVIEWER_SUBMITTED_EVIDENCE"]);
    });

    it("rule 2: refuses a reviewer from the operating organization", async () => {
      const insider = await addPerson("reviewer", fx.orgA);
      const credential = await addCredential(insider.subjectId, fx.orgA, fx.issuerAuthorityA);
      const claim = await createClaim();

      const response = await createCase([claim["id"] as string], insider.subjectId, credential);
      expect(response.statusCode).toBe(409);
      expect(response.json().details.violations).toEqual(["REVIEWER_SHARES_OPERATOR_ORGANIZATION"]);
    });

    it("02 §2.8: the assigner cannot appoint themselves", async () => {
      const credential = await addCredential(fx.stewardSubjectA, fx.reviewOrgA, fx.issuerAuthorityA);
      const claim = await createClaim();

      const response = await createCase([claim["id"] as string], fx.stewardSubjectA, credential);
      expect(response.statusCode).toBe(409);
      expect(response.json().details.violations).toContain("SELF_ASSIGNMENT");
    });

    it("an unknown submitter leaves the assignment unreviewed, and it cannot be signed on", async () => {
      const claimId = randomUUID();
      // A claim from before submitters were recorded.
      await fx.sql`
        INSERT INTO core.claims (
          id, tenant_id, project_id, claim_type, value_text, source_coordinate, evidence_tier
        ) VALUES (
          ${claimId}, ${fx.tenantA}, ${fx.projectA}, 'mining_right_registration', 'MV-LEGACY',
          '{"page":"1"}', 'P1'
        )
      `;
      const created = await createCase([claimId]);
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json().independenceReviewed).toBe(false);
      expect(created.json().independenceGaps).toEqual(["EVIDENCE_SUBMITTER_UNKNOWN"]);

      const drafted = await draft(created.json().id, created.json().assignmentId, [claimId]);
      expect(drafted.statusCode).toBe(422);
      expect(drafted.json().code).toBe("ATTESTATION_INDEPENDENCE_NOT_REVIEWED");
    });

    it("the credential must belong to the assigned reviewer", async () => {
      const other = await addPerson("reviewer", fx.reviewOrgA);
      const claim = await createClaim();
      const response = await createCase([claim["id"] as string], other.subjectId, fx.credentialA);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ASSIGNMENT_CREDENTIAL_NOT_HELD");
    });
  });

  // --- AC-15·AC-16: authority basis ---------------------------------------

  describe("authority basis", () => {
    it("AC-16: a credential with no linked issuer is not a basis for assignment", async () => {
      const unlinked = await addPerson("reviewer", fx.reviewOrgA);
      const credential = await addCredential(unlinked.subjectId, fx.reviewOrgA, null);
      const claim = await createClaim();

      const response = await createCase([claim["id"] as string], unlinked.subjectId, credential);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ASSIGNMENT_BASIS_REJECTED");
      expect(response.json().details.blockers).toEqual([
        "AUTHORITY_NOT_ACCEPTED",
        "CLAIM_OUTSIDE_AUTHORITY_SCOPE",
      ]);
    });

    it("AC-16: a proposed issuer is not a basis for assignment", async () => {
      const person = await addPerson("reviewer", fx.reviewOrgA);
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, await addIssuer("proposed"));
      const claim = await createClaim();

      const response = await createCase([claim["id"] as string], person.subjectId, credential);
      expect(response.statusCode).toBe(422);
      expect(response.json().details.blockers).toEqual(["AUTHORITY_NOT_ACCEPTED"]);
    });

    it("AC-15: a claim type outside the issuer's recognized scope is refused", async () => {
      const person = await addPerson("reviewer", fx.reviewOrgA);
      const issuer = await addIssuer("accepted", ["resource_estimate"]);
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, issuer);
      const claim = await createClaim("mining_right_registration");

      const response = await createCase([claim["id"] as string], person.subjectId, credential);
      expect(response.statusCode).toBe(422);
      expect(response.json().details.blockers).toEqual(["CLAIM_OUTSIDE_AUTHORITY_SCOPE"]);
      expect(response.json().details.outsideAuthorityScope).toEqual(["mining_right_registration"]);
    });

    it("the credential scope must cover every claim type, not merely be non-empty", async () => {
      const person = await addPerson("reviewer", fx.reviewOrgA);
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, fx.issuerAuthorityA, [
        "resource_estimate",
      ]);
      const claim = await createClaim("mining_right_registration");

      const response = await createCase([claim["id"] as string], person.subjectId, credential);
      expect(response.statusCode).toBe(422);
      expect(response.json().details.blockers).toEqual(["CREDENTIAL_SCOPE_MISMATCH"]);
    });

    it("AC-16: an issuer suspended after assignment blocks the draft", async () => {
      const person = await addPerson("reviewer", fx.reviewOrgA);
      const issuer = await addIssuer();
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, issuer);
      const claim = await createClaim();
      const created = await createCase([claim["id"] as string], person.subjectId, credential);
      expect(created.statusCode, created.body).toBe(200);

      await fx.sql`
        UPDATE core.authorities SET state = 'suspended', state_reason = 'Register under review'
        WHERE id = ${issuer}
      `;
      const drafted = await draft(
        created.json().id,
        created.json().assignmentId,
        [claim["id"] as string],
        {},
        person.token,
      );
      expect(drafted.statusCode).toBe(422);
      expect(drafted.json().code).toBe("ATTESTATION_BASIS_REJECTED");
      expect(drafted.json().details.blockers).toEqual(["AUTHORITY_NOT_ACCEPTED"]);
    });

    it("AC-16: an issuer suspended after the signature request blocks acceptance of a valid signature", async () => {
      const person = await addPerson("reviewer", fx.reviewOrgA);
      const issuer = await addIssuer();
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, issuer);
      const claim = await createClaim();
      const created = (await createCase([claim["id"] as string], person.subjectId, credential)).json();
      const drafted = (
        await draft(created.id, created.assignmentId, [claim["id"] as string], {}, person.token)
      ).json();
      const request = (await requestSignature(drafted.id, person.token)).json() as Json;

      await fx.sql`
        UPDATE core.authorities SET state = 'suspended', state_reason = 'Register under review'
        WHERE id = ${issuer}
      `;
      const submitted = await submit(drafted.id, request, person);
      expect(submitted.statusCode).toBe(422);
      expect(submitted.json().code).toBe("ATTESTATION_ACCEPTANCE_BLOCKED");
      expect(submitted.json().details.blockers).toEqual(["AUTHORITY_NOT_ACCEPTED"]);
    });

    it("an attestation cannot reach claims outside its case", async () => {
      const inside = await createClaim();
      const outside = await createClaim();
      const opened = await openCase([inside["id"] as string]);
      const drafted = await draft(opened.id, opened.assignmentId, [
        inside["id"] as string,
        outside["id"] as string,
      ]);
      expect(drafted.statusCode).toBe(422);
      expect(drafted.json().code).toBe("ATTESTATION_SCOPE_OUTSIDE_CASE");
    });
  });

  // --- REQ-DAPP-004: verification state follows verification ----------------

  describe("claim verification state", () => {
    it("signing moves the claim's state and records why on its history", async () => {
      const claim = await createClaim();
      const claimId = claim["id"] as string;
      expect((await claimRow(claimId)).verification_state).toBe("unreviewed");

      const signed = await signOver([claimId]);
      const after = await claimRow(claimId);
      expect(after.verification_state).toBe("analyst_checked");
      expect(after.grade).toBe("partially_verified");

      const history = await fx.sql<{ from_value: string | null; to_value: string; cause: string; actor_subject_id: string | null }[]>`
        SELECT from_value, to_value, cause, actor_subject_id FROM core.provenance_axis_history
        WHERE subject_id = ${claimId} AND axis = 'verification_state'
        ORDER BY recorded_at, id
      `;
      expect(history.map((row) => [row.from_value, row.to_value, row.cause])).toEqual([
        [null, "unreviewed", "claim_submitted"],
        ["unreviewed", "analyst_checked", `attestation_signed:${signed.attestationId}`],
      ]);
      expect(history[1]!.actor_subject_id).toBe(fx.reviewerSubjectA);
    });

    it("the axis history cannot be edited or deleted", async () => {
      const claim = await createClaim();
      await expect(
        fx.sql`UPDATE core.provenance_axis_history SET to_value = 'P5' WHERE subject_id = ${claim["id"] as string}`,
      ).rejects.toThrow(/cannot be modified/);
      await expect(
        fx.sql`DELETE FROM core.provenance_axis_history WHERE subject_id = ${claim["id"] as string}`,
      ).rejects.toThrow(/cannot be modified/);
    });

    it("an artifact's lifecycle follows its allowed transitions, each recorded", async () => {
      const artifactId = randomUUID();
      await fx.sql`
        INSERT INTO core.artifacts (id, tenant_id, project_id, kind, content_hash, sensitivity)
        VALUES (${artifactId}, ${fx.tenantA}, ${fx.projectA}, 'raw_source',
                ${`0x${"ab".repeat(32)}`}, 'restricted')
      `;
      // Revocation is recorded by its timestamp; the lifecycle follows it.
      await fx.sql`UPDATE core.artifacts SET revoked_at = now() WHERE id = ${artifactId}`;
      await expect(
        fx.sql`UPDATE core.artifacts SET lifecycle_state = 'validated' WHERE id = ${artifactId}`,
      ).rejects.toThrow(/not allowed/);

      const history = await fx.sql<{ from_value: string | null; to_value: string }[]>`
        SELECT from_value, to_value FROM core.provenance_axis_history
        WHERE subject_id = ${artifactId} AND axis = 'artifact_lifecycle'
        ORDER BY recorded_at, id
      `;
      expect(history.map((row) => [row.from_value, row.to_value])).toEqual([
        [null, "created"],
        ["created", "revoked"],
      ]);
    });
  });

  // --- REQ-DAPP-006: claim correction --------------------------------------

  describe("claim correction", () => {
    function correct(claimId: string, version: number | undefined, valueText = "MV-CORRECTED") {
      return app.inject({
        method: "POST",
        url: `/api/v1/claims/${claimId}/versions`,
        headers: {
          ...bearer(steward),
          "idempotency-key": idempotencyKey(),
          ...(version === undefined ? {} : { "if-match": `"${version}"` }),
        },
        payload: {
          valueText,
          sourceCoordinate: { document: "extract", page: "2" },
          evidenceTier: "P1",
          reason: "Transcription error in the license number",
        },
      });
    }

    it("creates a new version that supersedes the old one; the old value is kept", async () => {
      const claim = await createClaim();
      const claimId = claim["id"] as string;

      const corrected = await correct(claimId, claim["version"] as number);
      expect(corrected.statusCode, corrected.body).toBe(200);
      expect(corrected.json()).toMatchObject({
        supersedesClaimId: claimId,
        valueText: "MV-CORRECTED",
        verificationState: "unreviewed",
        claimType: "mining_right_registration",
      });

      const [old] = await fx.sql<
        { value_text: string; superseded_by_claim_id: string; stale_since: Date | null }[]
      >`
        SELECT value_text, superseded_by_claim_id, stale_since FROM core.claims WHERE id = ${claimId}
      `;
      expect(old!.value_text).toBe(claim["valueText"]);
      expect(old!.superseded_by_claim_id).toBe(corrected.json().id);
      expect(old!.stale_since).not.toBeNull();

      const [edge] = await fx.sql<{ relation_type: string }[]>`
        SELECT relation_type FROM core.lineage_edges
        WHERE from_id = ${corrected.json().id} AND to_id = ${claimId}
      `;
      expect(edge!.relation_type).toBe("supersedes");
    });

    it("an attestation over the corrected claim goes to re-review", async () => {
      const claim = await createClaim();
      const claimId = claim["id"] as string;
      const signed = await signOver([claimId]);
      await fx.sql`
        UPDATE core.verification_attestations SET state = 'active' WHERE id = ${signed.attestationId}
      `;

      const version = (await claimRow(claimId)).version;
      expect((await correct(claimId, version)).statusCode).toBe(200);

      const [row] = await fx.sql<{ state: string }[]>`
        SELECT state FROM core.verification_attestations WHERE id = ${signed.attestationId}
      `;
      expect(row!.state).toBe("stale_candidate");
    });

    it("readiness counts only the current version of a corrected claim", async () => {
      const claimType = `probe_${randomUUID().slice(0, 8)}`;
      const claim = await createClaim(claimType);
      expect((await correct(claim["id"] as string, claim["version"] as number)).statusCode).toBe(200);

      const facts = await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
        collectRequirementFacts(
          tx,
          fx.projectA,
          "MNG",
          [{ requirementId: "probe", requiredClaimTypes: [claimType] }] as unknown as Parameters<
            typeof collectRequirementFacts
          >[3],
          new Date(),
        ),
      );
      // One claim, two versions: the replaced one is history, not a second fact.
      expect(facts["probe"]!.presentClaimTypes.filter((type) => type === claimType)).toHaveLength(1);
    });

    it("a claim is corrected once — a second correction forks nothing", async () => {
      const claim = await createClaim();
      const first = await correct(claim["id"] as string, claim["version"] as number);
      expect(first.statusCode).toBe(200);

      const version = (await claimRow(claim["id"] as string)).version;
      const second = await correct(claim["id"] as string, version, "MV-OTHER");
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("CLAIM_ALREADY_SUPERSEDED");
    });

    it("requires If-Match", async () => {
      const claim = await createClaim();
      const response = await correct(claim["id"] as string, undefined);
      expect(response.statusCode).toBe(428);
    });

    it("the database refuses to edit or delete a claim's content", async () => {
      const claim = await createClaim();
      await expect(
        fx.sql`UPDATE core.claims SET value_text = 'MV-EDITED' WHERE id = ${claim["id"] as string}`,
      ).rejects.toThrow(/cannot be modified/);
      await expect(
        fx.sql`DELETE FROM core.claims WHERE id = ${claim["id"] as string}`,
      ).rejects.toThrow(/cannot be deleted/);
    });
  });

  // --- 07 §7.2: revoke and supersede ----------------------------------------

  describe("attestation revocation", () => {
    it("the signer revokes; the body stays, the case follows, the claim is reassessed", async () => {
      const claim = await createClaim();
      const claimId = claim["id"] as string;
      const signed = await signOver([claimId]);
      const [before] = await fx.sql<{ payload_hash: string; signature: string }[]>`
        SELECT payload_hash, signature FROM core.verification_attestations WHERE id = ${signed.attestationId}
      `;

      const response = await revokeAttestation(signed.attestationId);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        state: "revoked",
        previousState: "signed",
        caseState: "revoked",
        claims: [{ claimId, verificationState: "unreviewed", grade: "unverified" }],
      });

      const [after] = await fx.sql<
        { state: string; payload_hash: string; signature: string; revocation_reason: string; revoked_by: string }[]
      >`
        SELECT state, payload_hash, signature, revocation_reason, revoked_by
        FROM core.verification_attestations WHERE id = ${signed.attestationId}
      `;
      expect(after).toMatchObject({
        state: "revoked",
        payload_hash: before!.payload_hash,
        signature: before!.signature,
        revocation_reason: "Scope was misread",
        revoked_by: fx.reviewerSubjectA,
      });

      const events = await fx.sql<{ event_type: string }[]>`
        SELECT event_type FROM core.outbox WHERE aggregate_id = ${signed.attestationId}
      `;
      expect(events.map((row) => row.event_type)).toContain("verification_attestation.revoked");
      const audits = await fx.sql<{ command: string; reason: string }[]>`
        SELECT command, reason FROM audit.events
        WHERE resource_id = ${signed.attestationId} AND command = 'verification.attestation.revoked'
      `;
      expect(audits).toEqual([{ command: "verification.attestation.revoked", reason: "Scope was misread" }]);
    });

    it("only the signer can revoke", async () => {
      const claim = await createClaim();
      const signed = await signOver([claim["id"] as string]);
      const otherReviewer = await addPerson("reviewer", fx.reviewOrgA);

      const response = await revokeAttestation(signed.attestationId, otherReviewer.token);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("ATTESTATION_NOT_OWNED");
    });

    it("cannot be revoked twice", async () => {
      const claim = await createClaim();
      const signed = await signOver([claim["id"] as string]);
      expect((await revokeAttestation(signed.attestationId)).statusCode).toBe(200);

      const again = await revokeAttestation(signed.attestationId);
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("INVALID_STATE_TRANSITION");
    });

    it("requires a reason", async () => {
      const claim = await createClaim();
      const signed = await signOver([claim["id"] as string]);
      const response = await revokeAttestation(signed.attestationId, reviewer.token, "");
      expect(response.statusCode).toBe(400);
    });
  });

  describe("attestation supersession", () => {
    it("a signed correction supersedes its predecessor without deleting it", async () => {
      const claim = await createClaim();
      const claimId = claim["id"] as string;
      const first = await signOver([claimId]);

      const second = await signOver([claimId], { supersedesId: first.attestationId });
      expect(second.submitted["supersedesId"]).toBe(first.attestationId);

      const rows = await fx.sql<{ id: string; state: string; supersedes_id: string | null }[]>`
        SELECT id, state, supersedes_id FROM core.verification_attestations
        WHERE id IN (${first.attestationId}, ${second.attestationId})
      `;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId[first.attestationId]!.state).toBe("superseded");
      expect(byId[second.attestationId]).toMatchObject({ state: "signed", supersedes_id: first.attestationId });

      const [firstCase] = await fx.sql<{ state: string }[]>`
        SELECT state FROM core.verification_cases WHERE id = ${first.caseId}
      `;
      expect(firstCase!.state).toBe("superseded");

      const events = await fx.sql<{ event_type: string }[]>`
        SELECT event_type FROM core.outbox WHERE aggregate_id = ${first.attestationId}
      `;
      expect(events.map((row) => row.event_type)).toContain("verification_attestation.superseded");

      const [edge] = await fx.sql<{ relation_type: string }[]>`
        SELECT relation_type FROM core.lineage_edges
        WHERE from_id = ${second.attestationId} AND to_id = ${first.attestationId}
      `;
      expect(edge!.relation_type).toBe("supersedes");
      // The claim still stands on the correction.
      expect((await claimRow(claimId)).verification_state).toBe("analyst_checked");
    });

    it("a correction must cover every claim the predecessor covered", async () => {
      const a = await createClaim();
      const b = await createClaim();
      const first = await signOver([a["id"] as string, b["id"] as string]);

      const opened = await openCase([a["id"] as string]);
      const drafted = await draft(opened.id, opened.assignmentId, [a["id"] as string], {
        supersedesId: first.attestationId,
      });
      expect(drafted.statusCode).toBe(422);
      expect(drafted.json().code).toBe("SUPERSEDE_SCOPE_NARROWED");
    });

    it("a revoked attestation cannot be superseded", async () => {
      const claim = await createClaim();
      const first = await signOver([claim["id"] as string]);
      await revokeAttestation(first.attestationId);

      const opened = await openCase([claim["id"] as string]);
      const drafted = await draft(opened.id, opened.assignmentId, [claim["id"] as string], {
        supersedesId: first.attestationId,
      });
      expect(drafted.statusCode).toBe(409);
      expect(drafted.json().code).toBe("INVALID_STATE_TRANSITION");
    });
  });

  // --- REQ-DAPP-018·044: assignment revocation and reassignment ---------------

  describe("assignment changes", () => {
    function revokeAssignment(assignmentId: string, reason = "Reviewer unavailable") {
      return app.inject({
        method: "POST",
        url: `/api/v1/assignments/${assignmentId}/revoke`,
        headers: { ...bearer(steward), "idempotency-key": idempotencyKey() },
        payload: { reason },
      });
    }

    function reassign(assignmentId: string, reviewerSubjectId: string, credentialId: string) {
      return app.inject({
        method: "POST",
        url: `/api/v1/assignments/${assignmentId}/reassignments`,
        headers: { ...bearer(steward), "idempotency-key": idempotencyKey() },
        payload: {
          reviewerSubjectId,
          credentialId,
          conflictStatus: "none",
          reason: "Original reviewer declared a conflict",
        },
      });
    }

    it("revoking keeps the row and blocks the old reviewer's signature", async () => {
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);
      const drafted = (await draft(opened.id, opened.assignmentId, [claim["id"] as string])).json();

      const response = await revokeAssignment(opened.assignmentId);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ active: false, revokeReason: "Reviewer unavailable" });

      const [row] = await fx.sql<{ revoked_at: Date | null; revoked_by: string; revoke_reason: string }[]>`
        SELECT revoked_at, revoked_by, revoke_reason FROM core.assignments WHERE id = ${opened.assignmentId}
      `;
      expect(row!.revoked_at).not.toBeNull();
      expect(row!.revoked_by).toBe(fx.stewardSubjectA);

      expect((await requestSignature(drafted.id)).statusCode).toBe(403);

      // The case stays visible so someone can reassign it.
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/verification-cases`,
        headers: bearer(steward),
      });
      const listed = (list.json().items as Json[]).find((item) => item["id"] === opened.id);
      expect(listed).toMatchObject({ assignmentId: opened.assignmentId, assignmentActive: false });
    });

    it("reassigning appoints a checked reviewer and revokes the previous one", async () => {
      const replacement = await addPerson("reviewer", fx.reviewOrgA);
      const credential = await addCredential(replacement.subjectId, fx.reviewOrgA, fx.issuerAuthorityA);
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);

      const response = await reassign(opened.assignmentId, replacement.subjectId, credential);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        active: true,
        replacedAssignmentId: opened.assignmentId,
        independenceReviewed: true,
      });

      const rows = await fx.sql<{ id: string; revoked_at: Date | null }[]>`
        SELECT id, revoked_at FROM core.assignments WHERE case_id = ${opened.id} ORDER BY assigned_at
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.revoked_at).not.toBeNull();
      expect(rows[1]!.revoked_at).toBeNull();

      // The replacement can draft and sign on the same case.
      const drafted = await draft(
        opened.id,
        response.json().id,
        [claim["id"] as string],
        {},
        replacement.token,
      );
      expect(drafted.statusCode, drafted.body).toBe(200);
    });

    it("a replacement passes the same independence checks", async () => {
      const insider = await addPerson("reviewer", fx.orgA);
      const credential = await addCredential(insider.subjectId, fx.orgA, fx.issuerAuthorityA);
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);

      const response = await reassign(opened.assignmentId, insider.subjectId, credential);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ASSIGNMENT_INDEPENDENCE_VIOLATION");
      // Refused as a whole: the previous reviewer is still assigned.
      const [row] = await fx.sql<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM core.assignments WHERE id = ${opened.assignmentId}
      `;
      expect(row!.revoked_at).toBeNull();
    });

    it("a reassignment that lost a race is refused", async () => {
      const replacement = await addPerson("reviewer", fx.reviewOrgA);
      const credential = await addCredential(replacement.subjectId, fx.reviewOrgA, fx.issuerAuthorityA);
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);
      expect((await reassign(opened.assignmentId, replacement.subjectId, credential)).statusCode).toBe(200);

      const stale = await reassign(opened.assignmentId, fx.reviewerSubjectA, fx.credentialA);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("ASSIGNMENT_SUPERSEDED");
    });

    it("the original reviewer remains immutable before and after a signed review is disputed", async () => {
      const replacement = await addPerson("reviewer", fx.reviewOrgA);
      const credential = await addCredential(replacement.subjectId, fx.reviewOrgA, fx.issuerAuthorityA);
      const claim = await createClaim();
      const signed = await signOver([claim["id"] as string]);
      const [assignment] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.assignments WHERE case_id = ${signed.caseId}
      `;
      for (const disputed of [false,true]) {
        if (disputed) {
          const objection=await app.inject({method:"POST",url:`/api/v1/attestations/${signed.attestationId}/disputes`,
            headers:{...bearer(steward),"idempotency-key":idempotencyKey()},payload:{reasonCode:"CHECK",detail:"Check original signing scope"}});
          expect(objection.statusCode,objection.body).toBe(200);
        }
        for (const response of [await revokeAssignment(assignment!.id),await reassign(assignment!.id,replacement.subjectId,credential)]) {
          expect(response.statusCode,response.body).toBe(409);
          expect(response.json().code).toBe("CASE_NOT_REASSIGNABLE");
        }
        const list=await app.inject({method:"GET",url:`/api/v1/projects/${fx.projectA}/verification-cases`,headers:bearer(steward)});
        const current=list.json().items.find((row:{id:string})=>row.id===signed.caseId);
        expect(current.reviewerSubjectId).toBe(reviewer.subjectId);
        expect(current.latestAttestation.id).toBe(signed.attestationId);
      }
    });

    it("only the assigner's role may change assignments", async () => {
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/assignments/${opened.assignmentId}/revoke`,
        headers: { ...bearer(reviewer.token), "idempotency-key": idempotencyKey() },
        payload: { reason: "I would rather not" },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  it("preserves pre-channel manual history but refuses unknown confirmer provenance under runtime RLS", async () => {
    const database=`manual_history_${process.pid}_${Date.now()}`;
    await fx.sql.unsafe(`CREATE DATABASE ${database}`);
    const url=new URL(process.env["DATABASE_URL"]!);url.pathname=database;
    const legacy=postgres(url.toString(),{onnotice:()=>{},max:1});
    let runtime:ReturnType<typeof postgres>|undefined;
    try {
      const migrations=listMigrations(), boundary=migrations.findIndex(m=>m.name==='0021_evidence_channels.sql');
      expect(boundary).toBeGreaterThan(0);
      await runMigrations(legacy,migrations.slice(0,boundary));
      for(const [table,id] of [["tenants",fx.tenantA],["organizations",fx.orgA],["projects",fx.projectA],["authorities",fx.authorityA],["source_connections",fx.connectionA]]){
        const [row]=await fx.sql.unsafe(`SELECT to_jsonb(t) AS value FROM core.${table} t WHERE id=$1`,[id!]);
        const value=typeof row!.value === "string" ? JSON.parse(row!.value) : row!.value;
        await legacy`INSERT INTO ${legacy(`core.${table}`)} SELECT * FROM jsonb_populate_record(NULL::${legacy(`core.${table}`)},${legacy.json(value)})`;
      }
      const automaticProject=randomUUID(), looseProject=randomUUID(), manualReceipt=randomUUID(), automaticReceipt=randomUUID(), globalReceipt=randomUUID();
      for(const project of [automaticProject,looseProject]) await legacy`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
        VALUES(${project},${fx.tenantA},${`receipt-${project}`},'Receipt contrast','MNG',ARRAY['copper'],${fx.orgA})`;
      for(const [receipt,project,method] of [[manualReceipt,fx.projectA,'manual_official_registry_confirmation'],[automaticReceipt,automaticProject,'authenticated_api'],[globalReceipt,null,'manual_official_registry_confirmation']]){
        await legacy`INSERT INTO core.source_receipts(id,tenant_id,project_id,connection_id,authority_id,collection_method,result,query_basis,endpoint_or_document_ref,authentication_method,raw_hash,source_schema_version,adapter_version,terms_license,commercial_reuse,disclosure_permission,received_at,as_of,freshness_status,correlation_id)
          VALUES(${receipt!},${fx.tenantA},${project!},${fx.connectionA},${fx.authorityA},${method!},'confirmed_from_source','{}','Historical source','none',${`0x${"ab".repeat(32)}`},'1','1','Test only','unconfirmed','restricted',now(),now(),'fresh','test')`;
      }
      await runMigrations(legacy,migrations);
      const author=randomUUID(), manualClaim=randomUUID(), automaticClaim=randomUUID(), looseClaim=randomUUID();
      await legacy`INSERT INTO core.subjects(id,tenant_id,kind,display_name) VALUES(${author},${fx.tenantA},'person','Known claim author')`;
      for(const [claim,project,receipt] of [[manualClaim,fx.projectA,manualReceipt],[automaticClaim,automaticProject,automaticReceipt],[looseClaim,looseProject,globalReceipt]]){
        await legacy`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,submitted_by,source_receipt_id)
          VALUES(${claim!},${fx.tenantA},${project!},'mining_right_registration','Historical evidence','{}',${author},${receipt!})`;
      }
      const before=await legacy`SELECT * FROM core.source_receipts ORDER BY id`;
      url.username='mpc_app_login';url.password='app';
      runtime=postgres(url.toString(),{onnotice:()=>{},max:1});
      const [role]=await runtime`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      expect(role).toMatchObject({rolsuper:false,rolbypassrls:false});
      await withTenant(runtime,{tenantId:fx.tenantA},async tx=>{
        const manual=await loadEvidenceSubmitters(tx,[manualClaim]);
        expect(manual).toEqual({submitterIds:[author],allKnown:false});
        expect((await loadEvidenceSubmitters(tx,[automaticClaim])).allKnown).toBe(true);
        expect((await loadEvidenceSubmitters(tx,[looseClaim])).allKnown).toBe(false);
        const provenance={actors:new Set<string>(),complete:true};
        await collectRequirementFacts(tx,fx.projectA,'MNG',[],new Date(),provenance);
        expect(provenance.complete).toBe(false);
        expect([...provenance.actors]).toEqual([author]);
      });
      expect(await withTenant(runtime,{tenantId:fx.tenantB},tx=>tx`SELECT id FROM core.source_receipts`)).toEqual([]);
      expect(await legacy`SELECT * FROM core.source_receipts ORDER BY id`).toEqual(before);
    } finally {
      await runtime?.end();await legacy.end();
      await fx.sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
    }
  });

  it.each([true,false])("preserves legacy snapshot time and standing provenance (known uploader=%s)", async (known) => {
    const projectId=randomUUID(), artifact=randomUUID(), upload=randomUUID(), caseId=randomUUID(), assignmentId=randomUUID();
    const hash=`0x${"dc".repeat(32)}`;
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
      VALUES(${projectId},${fx.tenantA},${`legacy-time-${projectId}`},'Legacy time boundary','MNG',ARRAY['copper'],${fx.orgA})`;
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
      VALUES(${artifact},${fx.tenantA},${projectId},'raw_source',${hash},'restricted')`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,uploaded_by,promoted_artifact_id)
      VALUES(${upload},${fx.tenantA},${projectId},${`legacy-time-${upload}`},${hash},1,'application/pdf','restricted','promoted',${known ? verifier.subjectId : null},${artifact})`;
    const claim=await createClaim("mining_right_registration",projectId), claimId=claim["id"] as string;
    const snapshot=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>buildEvidenceSnapshot(tx,projectId,[claimId]));
    await fx.sql`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state,evidence_snapshot_hash)
      VALUES(${caseId},${fx.tenantA},${projectId},${fx.schemaA},'assigned',${snapshot.hash})`;
    await fx.sql`INSERT INTO core.verification_case_claims(tenant_id,case_id,claim_id) VALUES(${fx.tenantA},${caseId},${claimId})`;
    await fx.sql`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id,independence_reviewed,assigned_by)
      VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA},true,${fx.stewardSubjectA})`;
    const laterArtifact=randomUUID(), laterUpload=randomUUID();
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity,created_at)
      SELECT ${laterArtifact},${fx.tenantA},${projectId},'raw_source',${`0x${"ed".repeat(32)}`},'restricted',created_at+interval '1 second' FROM core.verification_cases WHERE id=${caseId}`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,uploaded_by,promoted_artifact_id)
      VALUES(${laterUpload},${fx.tenantA},${projectId},${`later-${laterUpload}`},${`0x${"ed".repeat(32)}`},1,'application/pdf','restricted','promoted',${fx.reviewerSubjectA},${laterArtifact})`;
    await fx.sql`INSERT INTO core.source_receipts(id,tenant_id,project_id,connection_id,authority_id,collection_method,result,query_basis,endpoint_or_document_ref,authentication_method,raw_hash,source_schema_version,adapter_version,terms_license,commercial_reuse,disclosure_permission,received_at,as_of,freshness_status,correlation_id,created_at)
      SELECT ${randomUUID()},${fx.tenantA},${projectId},${fx.connectionA},${fx.authorityA},'manual_official_registry_confirmation','manual_review_required','{}','Later unrelated source','none',${hash},'1','1','Test only','unconfirmed','restricted',now(),now(),'fresh','test',created_at+interval '1 second' FROM core.verification_cases WHERE id=${caseId}`;
    const revoked=await app.inject({method:"POST",url:`/api/v1/uploads/${upload}/revoke`,headers:{...bearer(steward),"idempotency-key":idempotencyKey(),"if-match":'"1"'},payload:{reason:"Retire historical raw attachment"}});
    expect(revoked.statusCode,revoked.body).toBe(200);
    const actors=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[claimId],caseId));
    expect(actors.allKnown).toBe(known);
    expect(actors.submitterIds).not.toContain(fx.reviewerSubjectA);
    if (known) {
      expect(actors.submitterIds).toContain(verifier.subjectId);
      const drafted=await draft(caseId,assignmentId,[claimId]);expect(drafted.statusCode,drafted.body).toBe(200);
      const requested=await requestSignature(drafted.json().id);expect(requested.statusCode,requested.body).toBe(200);
      expect((await submit(drafted.json().id,requested.json())).statusCode).toBe(200);
    } else {
      // Historical accepted reviews can predate uploader tracking; preserve their incomplete basis.
      await fx.sql`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
        VALUES(${randomUUID()},${fx.tenantA},${caseId},${assignmentId},${fx.credentialA},${fx.schemaA},'professional_signoff',${[claimId]}::uuid[],${snapshot.hash},'Historical synthetic review','{}','1','1',${hash},'',${reviewer.account.address.toLowerCase()},now(),'signed')`;
      const unused={actors:new Set<string>(),complete:true};
      await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>collectRequirementFacts(tx,projectId,'MNG',[],new Date(),unused));
      expect(unused.complete).toBe(true);
      await createClaim("resource_estimate",projectId);
      const base={...rulesFixture.requirements[1]!,minimumGrade:"unverified",freshnessThresholdDays:null,requiredAttestations:[],notEvaluableWhen:{op:"never"},watchWhen:null};
      for (const applies of [false,true]) {
        const policy=randomUUID();
        const definition={...rulesFixture,requirements:[
          {...base,requirementId:"applicable",requiredClaimTypes:["resource_estimate"],appliesWhen:{op:"always"}},
          {...base,requirementId:"historical",requiredClaimTypes:["mining_right_registration"],appliesWhen:{op:applies ? "always" : "never"}},
        ]};
        await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
          VALUES(${policy},${fx.tenantA},${`historical-provenance-${policy}`},'1.0.0','registry_publication','MNG',${new Date(Date.now()-60000)},${fx.sql.json(definition as never)},'effective')`;
        const assessed=await app.inject({method:"POST",url:`/api/v1/projects/${projectId}/readiness-assessments`,headers:{...bearer(steward),"idempotency-key":idempotencyKey()},payload:{policySetId:policy}});
        expect(assessed.statusCode,assessed.body).toBe(200);
        const [basis]=await fx.sql`SELECT evidence_actor_ids,requirement_results FROM core.compliance_assessments WHERE id=${assessed.json().id}`;
        const decision={gateId:"registry_publication",decision:"hold",inputAssessmentId:assessed.json().id,rationale:"Historical provenance follows applicability"};
        if (applies) {
          expect(basis!.evidence_actor_ids).toBeNull();
          expect((await requestGateDecisionSignature(app,secondVerifier.token,projectId,decision)).statusCode).toBe(409);
          expect((await submitGateDecision(app,secondVerifier.token,projectId,{...decision,signatureRequestId:randomUUID(),signature:`0x${"ab".repeat(65)}`})).statusCode).toBe(409);
        } else {
          expect(assessed.json().status).toBe("ok");
          expect(basis!.evidence_actor_ids).not.toBeNull();
          expect(basis!.requirement_results).toEqual(expect.arrayContaining([expect.objectContaining({requirementId:"historical",applicable:false})]));
          const accepted=await decideSigned(app,secondVerifier.token,secondVerifier.account,projectId,decision);
          expect(accepted.statusCode,accepted.body).toBe(200);
        }
      }
    }
    const [after]=await fx.sql`SELECT evidence_snapshot_hash,evidence_snapshot FROM core.verification_cases WHERE id=${caseId}`;
    expect(after).toMatchObject({evidence_snapshot_hash:snapshot.hash,evidence_snapshot:null});
  });

  it.each(["binding", "additional credential"])("rechecks live operator affiliation through %s after a signature request", async (source) => {
    const claim=await createClaim(), opened=await openCase([claim["id"] as string]);
    const drafted=await draft(opened.id,opened.assignmentId,[claim["id"] as string]);
    expect(drafted.statusCode,drafted.body).toBe(200);
    const requested=await requestSignature(drafted.json().id);
    expect(requested.statusCode,requested.body).toBe(200);
    const binding=source === "binding" ? randomUUID() : await addCredential(fx.reviewerSubjectA,fx.orgA,fx.issuerAuthorityA);
    if(source === "binding") await fx.sql`INSERT INTO core.role_bindings(id,tenant_id,subject_id,organization_id,role)
      VALUES(${binding},${fx.tenantA},${fx.reviewerSubjectA},${fx.orgA},'project_member')`;
    try {
      for(const response of [
        await draft(opened.id,opened.assignmentId,[claim["id"] as string]),
        await requestSignature(drafted.json().id),
        await submit(drafted.json().id,requested.json()),
        await submit(drafted.json().id,requested.json(),{...reviewer,token:steward}),
      ]) {
        expect(response.statusCode,response.body).toBe(422);
        expect(response.json().code).toBe("ATTESTATION_OPERATOR_NOT_INDEPENDENT");
      }
    } finally {
      if(source === "binding") await fx.sql`UPDATE core.role_bindings SET revoked_at=now() WHERE id=${binding}`;
      else await fx.sql`UPDATE core.credentials SET current_status='revoked',revoked_at=now() WHERE id=${binding}`;
    }
    expect((await submit(drafted.json().id,requested.json())).statusCode).toBe(200);
  });

  it("does not restore a review after its original signer's organization becomes unknown", async () => {
    const signer=await addPerson("reviewer",fx.reviewOrgA), resolver=await addPerson("reviewer",fx.reviewOrgA);
    const credential=await addCredential(signer.subjectId,null,fx.issuerAuthorityA), claim=await createClaim();
    const opened=await createCase([claim["id"] as string],signer.subjectId,credential);
    expect(opened.statusCode,opened.body).toBe(200);
    const drafted=await draft(opened.json().id,opened.json().assignmentId,[claim["id"] as string],{},signer.token);
    expect(drafted.statusCode,drafted.body).toBe(200);
    const attestationId=drafted.json().id, request=await requestSignature(attestationId,signer.token);
    expect((await submit(attestationId,request.json(),signer)).statusCode).toBe(200);
    const objection=await app.inject({method:"POST",url:`/api/v1/attestations/${attestationId}/disputes`,
      headers:{...bearer(steward),"idempotency-key":idempotencyKey()},payload:{reasonCode:"X",detail:"Check"}});
    expect(objection.statusCode,objection.body).toBe(200);
    await fx.sql`UPDATE core.role_bindings SET revoked_at=now() WHERE subject_id=${signer.subjectId} AND revoked_at IS NULL`;
    await fx.sql`INSERT INTO core.role_bindings(id,tenant_id,subject_id,role) VALUES(${randomUUID()},${fx.tenantA},${signer.subjectId},'reviewer')`;
    const [record]=await fx.sql`SELECT id FROM core.attestation_disputes WHERE attestation_id=${attestationId}`;
    const resolved=await app.inject({method:"POST",url:`/api/v1/disputes/${record!.id}/resolution`,
      headers:{...bearer(resolver.token),"idempotency-key":idempotencyKey()},payload:{outcome:"dismissed",resolution:"Finding checked; original affiliation needs review"}});
    expect(resolved.statusCode,resolved.body).toBe(200);expect(resolved.json().attestationState).toBe("stale_candidate");
    const [after]=await fx.sql`SELECT signature,credential_status_snapshot FROM core.verification_attestations WHERE id=${attestationId}`;
    expect(after!.signature).toMatch(/^0x/);expect(after!.credential_status_snapshot).toMatchObject({validAtAttestationTime:true});
    expect((await claimRow(claim["id"] as string)).verification_state).toBe("unreviewed");
  });

  it.each([0,-1])("checks direct document validity at restoration (UTC day offset=%s)", async (day) => {
    const extra=await setupFixture();
    try {
      const author=await signIn(app,extra.stewardA), signer={account:extra.reviewerA,subjectId:extra.reviewerSubjectA,token:await signIn(app,extra.reviewerA)};
      const [resolver]=await extra.sql`SELECT subject_id FROM core.wallet_identities WHERE wallet_address=${extra.approverA.address}`;
      await extra.sql`UPDATE core.role_bindings SET revoked_at=now() WHERE subject_id=${resolver!.subject_id} AND revoked_at IS NULL`;
      await extra.sql`INSERT INTO core.role_bindings(id,tenant_id,subject_id,organization_id,role) VALUES(${randomUUID()},${extra.tenantA},${resolver!.subject_id},${extra.reviewOrgA},'reviewer')`;
      const resolverToken=await signIn(app,extra.approverA), upload=randomUUID(),artifact=randomUUID(),catalog=randomUUID(),proposal=randomUUID();
      const hash=`0x${randomUUID().replaceAll("-","").repeat(2)}`;
      await extra.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
        VALUES(${artifact},${extra.tenantA},${extra.projectA},'raw_source',${hash},'restricted')`;
      await extra.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,uploaded_by,promoted_artifact_id,valid_until)
        VALUES(${upload},${extra.tenantA},${extra.projectA},${`expiry-${upload}`},${hash},1,'text/plain','restricted','promoted',${extra.stewardSubjectA},${artifact},(now() AT TIME ZONE 'UTC')::date)`;
      const payload={claimType:"mining_right_registration",displayName:"Direct expiry",description:null,definition:{fields:[{key:"reference",label:"Reference",type:"string",required:true}]}};
      await extra.sql.begin(async tx=>{
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${proposal},${extra.tenantA},'claim_type','mining_right_registration',1,${tx.json(payload)},'Expiry regression',now()-interval '1 minute',${extra.operatorSubjectA})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        VALUES(${catalog},${extra.tenantA},'mining_right_registration',1,'Direct expiry',${tx.json(payload.definition)},now()-interval '1 minute')`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${extra.reviewerSubjectA},decided_at=now(),decision_reason='Expiry regression',materialized_id=${catalog},version=2 WHERE id=${proposal}`;
      });
      const claim=await app.inject({method:"POST",url:`/api/v1/projects/${extra.projectA}/claims`,headers:{...bearer(author),"idempotency-key":idempotencyKey()},
        payload:{claimType:"mining_right_registration",valueText:"Direct file",catalogEntryId:catalog,structuredValues:{reference:"Direct file"},documentUploadIds:[upload],sourceCoordinate:{page:"1"},evidenceTier:"P1"}});
      expect(claim.statusCode,claim.body).toBe(200);const claimId=claim.json().id;
      const opened=await app.inject({method:"POST",url:"/api/v1/verification-cases",headers:{...bearer(author),"idempotency-key":idempotencyKey()},
        payload:{projectId:extra.projectA,schemaId:extra.schemaA,claimIds:[claimId],reviewerSubjectId:signer.subjectId,credentialId:extra.credentialA,conflictStatus:"none"}});
      expect(opened.statusCode,opened.body).toBe(200);
      const drafted=await draft(opened.json().id,opened.json().assignmentId,[claimId],{},signer.token);
      expect(drafted.statusCode,drafted.body).toBe(200);const attestationId=drafted.json().id;
      expect((await submit(attestationId,(await requestSignature(attestationId,signer.token)).json(),signer)).statusCode).toBe(200);
      const objection=await app.inject({method:"POST",url:`/api/v1/attestations/${attestationId}/disputes`,headers:{...bearer(author),"idempotency-key":idempotencyKey()},payload:{reasonCode:"X",detail:"Check direct attachment"}});
      expect(objection.statusCode,objection.body).toBe(200);
      await extra.sql`UPDATE core.object_uploads SET valid_until=(now() AT TIME ZONE 'UTC')::date+${day}::int WHERE id=${upload}`;
      const [raw]=await extra.sql`SELECT source_receipt_id,stale_since FROM core.claims WHERE id=${claimId}`;
      expect(raw).toMatchObject({source_receipt_id:null,stale_since:null});
      const [record]=await extra.sql`SELECT id FROM core.attestation_disputes WHERE attestation_id=${attestationId}`;
      const resolved=await app.inject({method:"POST",url:`/api/v1/disputes/${record!.id}/resolution`,headers:{...bearer(resolverToken),"idempotency-key":idempotencyKey()},payload:{outcome:"dismissed",resolution:"Finding checked; document validity decides ongoing support"}});
      expect(resolved.statusCode,resolved.body).toBe(200);expect(resolved.json().attestationState).toBe(day<0 ? "stale_candidate" : "active");
    } finally {await extra.close();}
  });

  it.each([false,true])("checks every case claim when an attestation selects a subset (manifest=%s)", async (withManifest) => {
    const projectId=randomUUID(), otherClaim=randomUUID(), caseId=randomUUID(), assignmentId=randomUUID();
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
      VALUES(${projectId},${fx.tenantA},${`subset-${projectId}`},'Subset independence','MNG',ARRAY['copper'],${fx.orgA})`;
    const claim=await createClaim("mining_right_registration",projectId);
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,submitted_by)
      VALUES(${otherClaim},${fx.tenantA},${projectId},'mining_right_registration','Reviewer contribution','{}',${fx.reviewerSubjectA})`;
    const claims=[claim["id"] as string,otherClaim];
    const snapshot=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>buildEvidenceSnapshot(tx,projectId,claims,{effectiveReceipts:withManifest}));
    await fx.sql`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state,evidence_snapshot_hash,evidence_snapshot)
      VALUES(${caseId},${fx.tenantA},${projectId},${fx.schemaA},'assigned',${snapshot.hash},${withManifest ? fx.sql.json(snapshot.manifest) : null})`;
    for(const id of claims) await fx.sql`INSERT INTO core.verification_case_claims(tenant_id,case_id,claim_id) VALUES(${fx.tenantA},${caseId},${id})`;
    // Simulate an older assignment that incorrectly claimed independence was reviewed.
    await fx.sql`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id,independence_reviewed,assigned_by)
      VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA},true,${fx.stewardSubjectA})`;
    const actors=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[claims[0]!],caseId));
    expect(actors.submitterIds).toContain(fx.reviewerSubjectA);
    const response=await draft(caseId,assignmentId,[claims[0]!]);
    expect(response.statusCode,response.body).toBe(422);
    expect(response.json().code).toBe("ATTESTATION_SELF_ASSURANCE");
    const assignment=await createCase(claims,fx.reviewerSubjectA,fx.credentialA,steward,projectId);
    expect(assignment.statusCode,assignment.body).toBe(409);
  });

  it("recovers new reviews and gate decisions after replacing legacy manual evidence without rewriting history", async () => {
    const projectId=randomUUID(), receipt=randomUUID(), artifact=randomUUID(), upload=randomUUID();
    const hash=`0x${"ab".repeat(32)}`;
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
      VALUES(${projectId},${fx.tenantA},${`receipt-recovery-${projectId}`},'Receipt recovery','MNG',ARRAY['copper'],${fx.orgA})`;
    await fx.sql`INSERT INTO core.source_receipts(id,tenant_id,project_id,connection_id,authority_id,collection_method,result,query_basis,endpoint_or_document_ref,authentication_method,raw_hash,source_schema_version,adapter_version,terms_license,commercial_reuse,disclosure_permission,received_at,as_of,freshness_status,correlation_id)
      VALUES(${receipt},${fx.tenantA},${projectId},${fx.connectionA},${fx.authorityA},'manual_official_registry_confirmation','manual_review_required','{}','Historical manual source','none',${hash},'1','1','Test only','unconfirmed','restricted',now(),now(),'fresh','test')`;
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity,source_receipt_id)
      VALUES(${artifact},${fx.tenantA},${projectId},'raw_source',${hash},'restricted',${receipt})`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,uploaded_by,promoted_artifact_id)
      VALUES(${upload},${fx.tenantA},${projectId},${`recovery-${upload}`},${hash},1,'application/pdf','restricted','promoted',${fx.stewardSubjectA},${artifact})`;
    const emptyProjectProvenance={actors:new Set<string>(),complete:true};
    await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>collectRequirementFacts(tx,projectId,'MNG',[],new Date(),emptyProjectProvenance));
    expect(emptyProjectProvenance.complete).toBe(false);
    expect([...emptyProjectProvenance.actors]).toContain(fx.stewardSubjectA);
    const claim=await createClaim("mining_right_registration",projectId,{sourceReceiptId:receipt});
    const original=await openCase([claim["id"] as string],projectId);
    const [beforeReceipt]=await fx.sql`SELECT to_jsonb(r) AS value FROM core.source_receipts r WHERE id=${receipt}`;
    const [beforeCase]=await fx.sql`SELECT evidence_snapshot_hash,evidence_snapshot FROM core.verification_cases WHERE id=${original.id}`;
    expect((await draft(original.id,original.assignmentId,[claim["id"] as string])).statusCode).toBe(422);
    const policy=randomUUID();
    await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
      VALUES(${policy},${fx.tenantA},${`receipt-recovery-${policy}`},'1.0.0','registry_publication','MNG',${new Date(Date.now()-60000)},${fx.sql.json(rulesFixture as never)},'effective')`;
    const assess=()=>app.inject({method:"POST",url:`/api/v1/projects/${projectId}/readiness-assessments`,headers:{...bearer(steward),"idempotency-key":idempotencyKey()},payload:{policySetId:policy}});
    const oldAssessment=await assess();
    expect(oldAssessment.statusCode,oldAssessment.body).toBe(200);
    const content={gateId:"registry_publication",decision:"hold",inputAssessmentId:oldAssessment.json().id,rationale:"Review corrected source evidence"};
    expect((await requestGateDecisionSignature(app,verifier.token,projectId,content)).statusCode).toBe(409);
    expect((await submitGateDecision(app,verifier.token,projectId,{...content,signatureRequestId:randomUUID(),signature:`0x${"ab".repeat(65)}`})).statusCode).toBe(409);

    const first=await app.inject({method:"POST",url:`/api/v1/projects/${projectId}/source-receipts`,headers:{...bearer(steward),"idempotency-key":idempotencyKey()},payload:{
      connectionId:fx.connectionA,authorityId:fx.authorityA,result:"manual_review_required",collectionMethod:"manual_official_registry_confirmation",
      queryBasis:{reference:"Replacement source"},endpointOrDocumentRef:"Synthetic replacement",authenticationMethod:"none",rawHash:hash,asOf:new Date().toISOString(),
    }});
    expect(first.statusCode,first.body).toBe(200);
    const confirmed=await app.inject({method:"POST",url:`/api/v1/source-receipts/${first.json().id}/second-review`,headers:{...bearer(secondVerifier.token),"idempotency-key":idempotencyKey()},payload:{observation:"Independently confirmed replacement",confirmed:true}});
    expect(confirmed.statusCode,confirmed.body).toBe(200);
    const corrected=await app.inject({method:"POST",url:`/api/v1/claims/${claim["id"]}/versions`,headers:{...bearer(steward),"idempotency-key":idempotencyKey(),"if-match":`"${claim["version"]}"`},payload:{valueText:"Confirmed replacement source",sourceCoordinate:{document:"Replacement source"},sourceReceiptId:confirmed.json().receiptId,reason:"Replace unattributed historical evidence"}});
    expect(corrected.statusCode,corrected.body).toBe(200);
    const correctedId=corrected.json().id as string;
    // The old source is still in use by an active artifact, so correcting only the claim is insufficient.
    expect((await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId]))).allKnown).toBe(false);
    await fx.sql`UPDATE core.artifacts SET revoked_at=now() WHERE id=${artifact}`;
    const recovered=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId]));
    expect(recovered.allKnown).toBe(true);
    expect(recovered.submitterIds).toEqual(expect.arrayContaining([fx.stewardSubjectA,secondVerifier.subjectId]));
    const fresh=await openCase([correctedId],projectId);
    const [frozen]=await fx.sql`SELECT evidence_snapshot FROM core.verification_cases WHERE id=${fresh.id}`;
    expect(frozen!.evidence_snapshot).toMatchObject({snapshotVersion:"3",receiptIds:[confirmed.json().receiptId],artifactIds:[]});
    // An unrelated later source/artifact cannot silently become part of an existing case.
    const later=randomUUID();
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity,source_receipt_id)
      VALUES(${later},${fx.tenantA},${projectId},'raw_source',${`0x${"cd".repeat(32)}`},'restricted',${receipt})`;
    expect((await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId],fresh.id))).allKnown).toBe(true);
    expect((await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId]))).allKnown).toBe(false);
    await fx.sql`UPDATE core.artifacts SET revoked_at=now() WHERE id=${later}`;
    const drafted=await draft(fresh.id,fresh.assignmentId,[correctedId]);
    expect(drafted.statusCode,drafted.body).toBe(200);
    const requested=await requestSignature(drafted.json().id);
    expect(requested.statusCode,requested.body).toBe(200);
    const signed=await submit(drafted.json().id,requested.json());
    expect(signed.statusCode,signed.body).toBe(200);
    const next=await assess();
    expect(next.statusCode,next.body).toBe(200);
    const decided=await decideSigned(app,verifier.token,verifier.account,projectId,{...content,inputAssessmentId:next.json().id});
    expect(decided.statusCode,decided.body).toBe(200);
    expect((await requestGateDecisionSignature(app,verifier.token,projectId,content)).statusCode).toBe(409);
    expect((await draft(original.id,original.assignmentId,[claim["id"] as string])).statusCode).toBe(422);
    const attributedRaw=randomUUID();
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity,source_receipt_id)
      VALUES(${attributedRaw},${fx.tenantA},${projectId},'raw_source',${`0x${"ac".repeat(32)}`},'restricted',${confirmed.json().receiptId})`;
    expect((await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId]))).allKnown).toBe(true);
    const orphan=randomUUID();
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
      VALUES(${orphan},${fx.tenantA},${projectId},'raw_source',${`0x${"ce".repeat(32)}`},'restricted')`;
    expect((await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId]))).allKnown).toBe(false);
    const orphanCase=await openCase([correctedId],projectId);
    const orphanDraft=await draft(orphanCase.id,orphanCase.assignmentId,[correctedId]);
    expect(orphanDraft.statusCode,orphanDraft.body).toBe(422);
    expect(orphanDraft.json().code).toBe("ATTESTATION_INDEPENDENCE_NOT_REVIEWED");
    const orphanAssessment=await assess();
    expect(orphanAssessment.statusCode,orphanAssessment.body).toBe(200);
    const orphanDecision={...content,inputAssessmentId:orphanAssessment.json().id};
    expect((await requestGateDecisionSignature(app,verifier.token,projectId,orphanDecision)).statusCode).toBe(409);
    expect((await submitGateDecision(app,verifier.token,projectId,{...orphanDecision,signatureRequestId:randomUUID(),signature:`0x${"ab".repeat(65)}`})).statusCode).toBe(409);
    // Simulate explicit owner retirement of legacy metadata that has no upload API record.
    await fx.sql`UPDATE core.artifacts SET revoked_at=now() WHERE id=${orphan}`;
    expect((await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId],orphanCase.id))).allKnown).toBe(false);
    expect((await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[correctedId]))).allKnown).toBe(true);
    await signOver([correctedId],{},projectId);
    const [afterReceipt]=await fx.sql`SELECT to_jsonb(r) AS value FROM core.source_receipts r WHERE id=${receipt}`;
    const [afterCase]=await fx.sql`SELECT evidence_snapshot_hash,evidence_snapshot FROM core.verification_cases WHERE id=${original.id}`;
    expect(afterReceipt).toEqual(beforeReceipt);expect(afterCase).toEqual(beforeCase);
    expect(await withTenant(fx.appSql,{tenantId:fx.tenantB},tx=>loadEvidenceSubmitters(tx,[correctedId],fresh.id))).toEqual({submitterIds:[],allKnown:false});
  });

  it("freezes gate contributors and refuses their own decision at both signature boundaries", async () => {
    const projectId=randomUUID();
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
      VALUES(${projectId},${fx.tenantA},${`gate-isolation-${projectId}`},'Gate independence','MNG',ARRAY['copper'],${fx.orgA})`;
    const sourceAuthor=await addPerson("reviewer",fx.reviewOrgA), uploader=await addPerson("reviewer",fx.reviewOrgA);
    const receipt=randomUUID(), document=randomUUID(), hash=`0x${"ab".repeat(32)}`;
    await fx.sql`INSERT INTO core.source_receipts(id,tenant_id,project_id,connection_id,authority_id,collection_method,result,query_basis,endpoint_or_document_ref,authentication_method,raw_hash,source_schema_version,adapter_version,terms_license,commercial_reuse,disclosure_permission,received_at,as_of,freshness_status,correlation_id,first_confirmed_by,second_confirmed_by,second_confirmed_at)
      VALUES(${receipt},${fx.tenantA},${projectId},${fx.connectionA},${fx.authorityA},'manual_official_registry_confirmation','confirmed_from_source','{}','Synthetic source','none',${hash},'1','1','Test only','unconfirmed','restricted',now(),now(),'fresh','test',${sourceAuthor.subjectId},${verifier.subjectId},now())`;
    const wrongProject=await app.inject({method:"POST",url:`/api/v1/projects/${fx.projectA}/claims`,headers:{...bearer(steward),"idempotency-key":idempotencyKey()},payload:{claimType:"resource_estimate",valueText:"Wrong project source",sourceCoordinate:{document:"Synthetic source"},sourceReceiptId:receipt}});
    expect(wrongProject.statusCode,wrongProject.body).toBe(422);
    expect(wrongProject.json().code).toBe("CLAIM_RECEIPT_UNAVAILABLE");
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,uploaded_by)
      VALUES(${document},${fx.tenantA},${projectId},${`test/${document}`},${hash},1,'text/plain','restricted','scanned_clean',${uploader.subjectId})`;
    const catalog=randomUUID(),catalogProposal=randomUUID(),effectiveAt=new Date(Date.now()-60000);
    const catalogPayload={claimType:"mining_right_registration",displayName:"Synthetic mining licence",description:null,definition:{fields:[{key:"reference",label:"Reference",type:"string",required:true}]}};
    await fx.sql.begin(async tx=>{
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${catalogProposal},${fx.tenantA},'claim_type','mining_right_registration',1,${tx.json(catalogPayload)},'Synthetic regression',${effectiveAt},${fx.operatorSubjectA})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        VALUES(${catalog},${fx.tenantA},'mining_right_registration',1,'Synthetic mining licence',${tx.json(catalogPayload.definition)},${effectiveAt})`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Synthetic regression',materialized_id=${catalog},version=2 WHERE id=${catalogProposal}`;
    });
    const claim = await createClaim("mining_right_registration",projectId,{catalogEntryId:catalog,structuredValues:{reference:"Synthetic proof"},sourceReceiptId:receipt,documentUploadIds:[document]});
    const uploaderCredential=await addCredential(uploader.subjectId,fx.reviewOrgA,fx.issuerAuthorityA);
    const legacyUploader=await addPerson("reviewer",fx.reviewOrgA);
    const legacyCredential=await addCredential(legacyUploader.subjectId,fx.reviewOrgA,fx.issuerAuthorityA);
    const legacyArtifact=randomUUID(), legacyUpload=randomUUID(), legacyHash=`0x${"cd".repeat(32)}`;
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
      VALUES(${legacyArtifact},${fx.tenantA},${projectId},'raw_source',${legacyHash},'restricted')`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,uploaded_by,promoted_artifact_id)
      VALUES(${legacyUpload},${fx.tenantA},${projectId},${`legacy-${legacyUpload}`},${legacyHash},1,'application/pdf','restricted','promoted',${legacyUploader.subjectId},${legacyArtifact})`;
    const unstructured=await createClaim("resource_estimate",projectId);
    const legacySnapshot=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>buildEvidenceSnapshot(tx,projectId,[unstructured["id"] as string]));
    expect(legacySnapshot.artifactIds).toContain(legacyArtifact);
    const legacyAssignmentAttempt=await createCase([unstructured["id"] as string],legacyUploader.subjectId,legacyCredential,steward,projectId);
    expect(legacyAssignmentAttempt.statusCode,legacyAssignmentAttempt.body).toBe(409);
    expect(legacyAssignmentAttempt.json().details.violations).toContain("REVIEWER_SUBMITTED_EVIDENCE");
    const refusedAssignment=await createCase([claim["id"] as string],uploader.subjectId,uploaderCredential,steward,projectId);
    expect(refusedAssignment.statusCode).toBe(409);
    expect(refusedAssignment.json().details.violations).toContain("REVIEWER_SUBMITTED_EVIDENCE");
    // A historical assignment/draft made before uploader tracking must fail every later signing boundary.
    const legacyCase=randomUUID(), legacyAssignment=randomUUID(), legacyDraft=randomUUID();
    const snapshot=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>buildEvidenceSnapshot(tx,projectId,[claim["id"] as string]));
    await fx.sql`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state,evidence_snapshot_hash)
      VALUES(${legacyCase},${fx.tenantA},${projectId},${fx.schemaA},'assigned',${snapshot.hash})`;
    await fx.sql`INSERT INTO core.verification_case_claims(tenant_id,case_id,claim_id) VALUES(${fx.tenantA},${legacyCase},${claim["id"] as string})`;
    await fx.sql`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id,independence_reviewed,assigned_by)
      VALUES(${legacyAssignment},${fx.tenantA},${legacyCase},${legacyUploader.subjectId},${legacyCredential},true,${fx.stewardSubjectA})`;
    const refusedDraft=await draft(legacyCase,legacyAssignment,[claim["id"] as string],{},legacyUploader.token);
    expect(refusedDraft.statusCode).toBe(422);
    expect(refusedDraft.json().code).toBe("ATTESTATION_SELF_ASSURANCE");
    await fx.sql`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
      VALUES(${legacyDraft},${fx.tenantA},${legacyCase},${legacyAssignment},${legacyCredential},${fx.schemaA},'professional_signoff',${[claim["id"] as string]}::uuid[],${snapshot.hash},'Historical synthetic draft','{}','1','1',${hash},'',${`0x${"00".repeat(20)}`},now(),'draft')`;
    await fx.sql`UPDATE core.artifacts SET revoked_at=now() WHERE id=${legacyArtifact}`;
    const historicalActors=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[unstructured["id"] as string],legacyCase));
    expect(historicalActors.submitterIds).toContain(legacyUploader.subjectId);
    const liveActors=await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>loadEvidenceSubmitters(tx,[unstructured["id"] as string]));
    expect(liveActors.submitterIds).not.toContain(legacyUploader.subjectId);
    const refusedRequest=await requestSignature(legacyDraft,legacyUploader.token);
    expect(refusedRequest.statusCode).toBe(422);
    expect(refusedRequest.json().code).toBe("ATTESTATION_SELF_ASSURANCE");
    const requestId=randomUUID(), issuedAt=BigInt(Math.floor(Date.now()/1000)),expiresAt=issuedAt+600n,nonce=newSignatureNonce();
    await fx.sql`INSERT INTO core.attestation_signature_requests(id,tenant_id,attestation_id,nonce,evidence_snapshot_hash,payload_hash,issued_at,expires_at)
      VALUES(${requestId},${fx.tenantA},${legacyDraft},${nonce},${snapshot.hash},${hash},${new Date(Number(issuedAt)*1000)},${new Date(Number(expiresAt)*1000)})`;
    const typedData=buildTypedData(loadConfig(testEnv()),{attestationId:uuidToBytes32(legacyDraft),schemaId:uuidToBytes32(fx.schemaA),schemaVersion:1,evidenceSnapshotHash:snapshot.hash,assignmentId:uuidToBytes32(legacyAssignment),credentialId:uuidToBytes32(legacyCredential),payloadHash:hash as `0x${string}`,issuedAt,expiresAt,nonce:nonce as `0x${string}`});
    for (const signer of [legacyUploader,{...legacyUploader,token:steward}]) {
      const refused=await submit(legacyDraft,{typedData,signatureRequestId:requestId},signer);
      expect(refused.statusCode,refused.body).toBe(422);
      expect(refused.json().code).toBe("ATTESTATION_SELF_ASSURANCE");
    }
    const rawUploader=await addPerson("reviewer",fx.reviewOrgA), rawArtifact=randomUUID(), rawUpload=randomUUID();
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
      VALUES(${rawArtifact},${fx.tenantA},${projectId},'raw_source',${`0x${"ba".repeat(32)}`},'restricted')`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,uploaded_by,promoted_artifact_id)
      VALUES(${rawUpload},${fx.tenantA},${projectId},${`standing-${rawUpload}`},${`0x${"ba".repeat(32)}`},1,'application/pdf','restricted','promoted',${rawUploader.subjectId},${rawArtifact})`;
    const standing=await signOver([claim["id"] as string],{},projectId);
    const revoked=await app.inject({method:"POST",url:`/api/v1/uploads/${rawUpload}/revoke`,headers:{...bearer(steward),"idempotency-key":idempotencyKey(),"if-match":'"1"'},payload:{reason:"Retire raw attachment"}});
    expect(revoked.statusCode,revoked.body).toBe(200);
    const [stillStanding]=await fx.sql`SELECT state FROM core.verification_attestations WHERE id=${standing.attestationId}`;
    expect(stillStanding!.state).toBe("signed");
    const policy = randomUUID();
    await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
      VALUES(${policy},${fx.tenantA},${`gate-independence-${policy}`},'1.0.0','registry_publication','MNG',now(),${fx.sql.json(rulesFixture as never)},'effective')`;
    const assess = () => app.inject({method:"POST",url:`/api/v1/projects/${projectId}/readiness-assessments`,headers:{...bearer(steward),"idempotency-key":idempotencyKey()},payload:{policySetId:policy}});
    const assessed = await assess();
    expect(assessed.statusCode,assessed.body).toBe(200);
    const assessmentId = assessed.json().id;
    const [basis] = await fx.sql<{evidence_actor_ids:string[]}[]>`SELECT evidence_actor_ids FROM core.compliance_assessments WHERE id=${assessmentId}`;
    expect(basis!.evidence_actor_ids).toEqual(expect.arrayContaining([fx.stewardSubjectA,fx.reviewerSubjectA,sourceAuthor.subjectId,uploader.subjectId,verifier.subjectId,rawUploader.subjectId]));
    await expect(fx.sql`UPDATE core.compliance_assessments SET evidence_actor_ids='{}' WHERE id=${assessmentId}`).rejects.toThrow();
    const content={gateId:"registry_publication",decision:"hold",inputAssessmentId:assessmentId,rationale:"Independent approval is required"};
    for (const auth of [steward,reviewer.token,sourceAuthor.token,uploader.token,rawUploader.token]) {
      const request=await requestGateDecisionSignature(app,auth,projectId,content);
      expect(request.statusCode).toBe(403);
      expect(request.json().code).toBe("GATE_DECISION_NOT_INDEPENDENT");
      const submission=await submitGateDecision(app,auth,projectId,{...content,signatureRequestId:randomUUID(),signature:`0x${"ab".repeat(65)}`});
      expect(submission.statusCode).toBe(403);
      expect(submission.json().code).toBe("GATE_DECISION_NOT_INDEPENDENT");
    }
    await expect(fx.sql`INSERT INTO core.gate_decisions(id,tenant_id,project_id,gate_id,decision,input_assessment_id,evidence_snapshot_hash,decision_authority,decision_maker_subject_id,rationale)
      VALUES(${randomUUID()},${fx.tenantA},${projectId},'registry_publication','hold',${assessmentId},${`0x${"ab".repeat(32)}`},'Test',${fx.reviewerSubjectA},'Self approval')`).rejects.toThrow("Gate decider must be independent");
    const independent = await addPerson("reviewer",fx.reviewOrgA);
    // Later evidence does not change who contributed to an already-frozen assessment.
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,submitted_by)
      VALUES(${randomUUID()},${fx.tenantA},${projectId},'later_context','Later evidence','{}',${independent.subjectId})`;
    const accepted=await decideSigned(app,independent.token,independent.account,projectId,content);
    expect(accepted.statusCode,accepted.body).toBe(200);
    const next=await assess();
    expect((await requestGateDecisionSignature(app,independent.token,projectId,{...content,inputAssessmentId:next.json().id})).statusCode).toBe(403);
    const anonymousArtifact=randomUUID(), anonymousUpload=randomUUID(), anonymousHash=`0x${"ef".repeat(32)}`;
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
      VALUES(${anonymousArtifact},${fx.tenantA},${projectId},'raw_source',${anonymousHash},'restricted')`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,promoted_artifact_id)
      VALUES(${anonymousUpload},${fx.tenantA},${projectId},${`anonymous-${anonymousUpload}`},${anonymousHash},1,'application/pdf','restricted','promoted',${anonymousArtifact})`;
    const unknownUpload=await assess();
    const [unknownBasis]=await fx.sql`SELECT evidence_actor_ids FROM core.compliance_assessments WHERE id=${unknownUpload.json().id}`;
    expect(unknownBasis!.evidence_actor_ids).toBeNull();
    const unknownContent={...content,inputAssessmentId:unknownUpload.json().id};
    expect((await requestGateDecisionSignature(app,verifier.token,projectId,unknownContent)).statusCode).toBe(409);
    expect((await submitGateDecision(app,verifier.token,projectId,{...unknownContent,signatureRequestId:randomUUID(),signature:`0x${"ab".repeat(65)}`})).statusCode).toBe(409);
    await fx.sql`UPDATE core.artifacts SET revoked_at=now() WHERE id=${anonymousArtifact}`;
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate)
      VALUES(${randomUUID()},${fx.tenantA},${projectId},'unknown_legacy_author','Unattributed legacy evidence','{}')`;
    const unknown=await assess();
    const blocked=await requestGateDecisionSignature(app,verifier.token,projectId,{...content,inputAssessmentId:unknown.json().id});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("GATE_ASSESSMENT_RECOMPUTE_REQUIRED");
  });

  // --- REQ-DAPP-042·044: credential status ----------------------------------

  describe("credential status", () => {
    async function freshCredential(): Promise<{ id: string; holder: Person }> {
      const holder = await addPerson("reviewer", fx.reviewOrgA);
      return { id: await addCredential(holder.subjectId, fx.reviewOrgA, fx.issuerAuthorityA), holder };
    }

    async function versionOf(credentialId: string): Promise<number> {
      const [row] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.credentials WHERE id = ${credentialId}
      `;
      return row!.version;
    }

    async function change(credentialId: string, status: string, token: string, version?: number) {
      return app.inject({
        method: "POST",
        url: `/api/v1/credentials/${credentialId}/status`,
        headers: {
          ...bearer(token),
          "idempotency-key": idempotencyKey(),
          "if-match": `"${version ?? (await versionOf(credentialId))}"`,
        },
        payload: { status, reason: "Issuer register shows a change" },
      });
    }

    it("keeps reviewer restoration authority when the same person is also an administrator", async () => {
      const {id}=await freshCredential();
      expect((await change(id,"suspended",verifier.token)).statusCode).toBe(200);
      const both=await addPerson("reviewer",fx.reviewOrgA);
      await fx.sql`INSERT INTO core.role_bindings(id,tenant_id,subject_id,organization_id,role)
        VALUES(${randomUUID()},${fx.tenantA},${both.subjectId},${fx.orgA},'administrator')`;
      const auth=await signIn(app,both.account);
      const restored=await change(id,"valid",auth);
      expect(restored.statusCode,restored.body).toBe(200);
      const [audit]=await fx.sql`SELECT effective_role FROM audit.events WHERE resource_id=${id} AND actor_subject_id=${both.subjectId}`;
      expect(audit!.effective_role).toBe("reviewer");
    });

    it("records the change, its history, an audit entry and an event", async () => {
      const { id } = await freshCredential();
      const response = await change(id, "suspended", verifier.token);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ previousStatus: "valid", currentStatus: "suspended", version: 2 });

      const history = await fx.sql<{ from_status: string; to_status: string; actor_subject_id: string }[]>`
        SELECT from_status, to_status, actor_subject_id FROM core.credential_status_events
        WHERE credential_id = ${id}
      `;
      expect(history).toEqual([
        { from_status: "valid", to_status: "suspended", actor_subject_id: verifier.subjectId },
      ]);
      // Creating the fixture credential emits `credential.verified` from the status trigger;
      // the change itself emits once.
      const events = await fx.sql<{ event_type: string }[]>`
        SELECT event_type FROM core.outbox
        WHERE aggregate_id = ${id} AND event_type <> 'credential.verified'
      `;
      expect(events.map((row) => row.event_type)).toEqual(["credential.suspended"]);
      const audits = await fx.sql<{ command: string }[]>`
        SELECT command FROM audit.events WHERE resource_id = ${id}
      `;
      expect(audits.map((row) => row.command)).toEqual(["credential.status.changed"]);
    });

    it("the person who suspended cannot lift the suspension; someone else can", async () => {
      const { id } = await freshCredential();
      expect((await change(id, "suspended", verifier.token)).statusCode).toBe(200);

      const self = await change(id, "valid", verifier.token);
      expect(self.statusCode).toBe(403);
      expect(self.json().code).toBe("REINSTATEMENT_BY_SUSPENDER");

      const other = await change(id, "valid", secondVerifier.token);
      expect(other.statusCode).toBe(200);
      expect(other.json().currentStatus).toBe("valid");
    });

    it("only lifting a suspension emits credential.reinstated", async () => {
      const { id } = await freshCredential();
      await fx.sql`UPDATE core.credentials SET current_status = 'unknown' WHERE id = ${id}`;

      const restored = await change(id, "valid", verifier.token);
      expect(restored.statusCode).toBe(200);
      const events = await fx.sql<{ event_type: string }[]>`
        SELECT event_type FROM core.outbox
        WHERE aggregate_id = ${id} AND event_type = 'credential.reinstated'
      `;
      expect(events).toEqual([]);
    });

    it("revocation is terminal and stamps revoked_at", async () => {
      const { id } = await freshCredential();
      const revoked = await change(id, "revoked", verifier.token);
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().revokedAt).not.toBeNull();

      // The status trigger emits `credential.revoked`; the route does not add a second one.
      const events = await fx.sql<{ event_type: string }[]>`
        SELECT event_type FROM core.outbox
        WHERE aggregate_id = ${id} AND event_type = 'credential.revoked'
      `;
      expect(events).toHaveLength(1);

      const back = await change(id, "valid", secondVerifier.token);
      expect(back.statusCode).toBe(409);
      expect(back.json().code).toBe("INVALID_STATE_TRANSITION");
    });

    it("break_glass may revoke or suspend, but not restore or expire", async () => {
      const { id } = await freshCredential();
      const expire = await change(id, "expired", securityOperator.token);
      expect(expire.statusCode).toBe(403);
      expect(expire.json().code).toBe("BREAK_GLASS_SCOPE_EXCEEDED");

      expect((await change(id, "revoked", securityOperator.token)).statusCode).toBe(200);
    });

    it("the holder cannot change their own credential", async () => {
      const own = await addCredential(verifier.subjectId, fx.reviewOrgA, fx.issuerAuthorityA);
      const response = await change(own, "expired", verifier.token);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("CREDENTIAL_SELF_STATUS_CHANGE");
    });

    it("a role outside credential verification is refused", async () => {
      const { id } = await freshCredential();
      const response = await change(id, "revoked", await signIn(app, fx.proposerA));
      expect(response.statusCode).toBe(403);
    });

    it("rejects a stale version", async () => {
      const { id } = await freshCredential();
      const response = await change(id, "suspended", verifier.token, 99);
      expect(response.statusCode).toBe(412);
    });

    it("AC-17: revoking after the signature request blocks acceptance; a signed past stays", async () => {
      const { id, holder } = await freshCredential();
      const claim = await createClaim();
      const claimId = claim["id"] as string;
      const created = (await createCase([claimId], holder.subjectId, id)).json();
      const drafted = (await draft(created.id, created.assignmentId, [claimId], {}, holder.token)).json();
      const request = (await requestSignature(drafted.id, holder.token)).json() as Json;

      expect((await change(id, "revoked", verifier.token)).statusCode).toBe(200);

      const submitted = await submit(drafted.id, request, holder);
      expect(submitted.statusCode).toBe(422);
      expect(submitted.json().details.blockers).toEqual(["CREDENTIAL_INVALID"]);
    });

    it("AC-17: a signature made while valid keeps its snapshot after revocation", async () => {
      const { id, holder } = await freshCredential();
      const claim = await createClaim();
      const claimId = claim["id"] as string;
      const created = (await createCase([claimId], holder.subjectId, id)).json();
      const drafted = (await draft(created.id, created.assignmentId, [claimId], {}, holder.token)).json();
      const request = (await requestSignature(drafted.id, holder.token)).json() as Json;
      expect((await submit(drafted.id, request, holder)).statusCode).toBe(200);

      expect((await change(id, "revoked", verifier.token)).statusCode).toBe(200);

      const [row] = await fx.sql<{ credential_status_snapshot: Json; state: string }[]>`
        SELECT credential_status_snapshot, state FROM core.verification_attestations WHERE id = ${drafted.id}
      `;
      expect(row!.state).toBe("signed");
      expect(row!.credential_status_snapshot).toMatchObject({
        statusAtSigning: "valid",
        validAtAttestationTime: true,
      });
    });
  });
});
