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
  type TestFixture,
} from "./helpers/db.js";

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
  /** reviewer_assurance — the registry approver role that verifies credentials (02 §2.8). */
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
    organizationId: string,
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

  async function createClaim(claimType = "mining_right_registration"): Promise<Json> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { ...bearer(steward), "idempotency-key": idempotencyKey() },
      payload: {
        claimType,
        valueText: `MV-${randomUUID().slice(0, 6)}`,
        sourceCoordinate: { document: "extract", page: "1" },
        evidenceTier: "P1",
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
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: fx.schemaA,
        claimIds,
        reviewerSubjectId,
        credentialId,
        conflictStatus: "none",
      },
    });
  }

  async function openCase(claimIds: readonly string[]): Promise<{ id: string; assignmentId: string }> {
    const response = await createCase(claimIds);
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
  async function signOver(claimIds: readonly string[], overrides: Record<string, unknown> = {}) {
    const opened = await openCase(claimIds);
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
    verifier = await addPerson("reviewer_assurance", fx.reviewOrgA);
    secondVerifier = await addPerson("reviewer_assurance", fx.reviewOrgA);
    securityOperator = await addPerson("security_operator", fx.orgA);
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
      const insider = await addPerson("reviewer_cp_qp", fx.orgA);
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
      const other = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
      const claim = await createClaim();
      const response = await createCase([claim["id"] as string], other.subjectId, fx.credentialA);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ASSIGNMENT_CREDENTIAL_NOT_HELD");
    });
  });

  // --- AC-15·AC-16: authority basis ---------------------------------------

  describe("authority basis", () => {
    it("AC-16: a credential with no linked issuer is not a basis for assignment", async () => {
      const unlinked = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
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
      const person = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, await addIssuer("proposed"));
      const claim = await createClaim();

      const response = await createCase([claim["id"] as string], person.subjectId, credential);
      expect(response.statusCode).toBe(422);
      expect(response.json().details.blockers).toEqual(["AUTHORITY_NOT_ACCEPTED"]);
    });

    it("AC-15: a claim type outside the issuer's recognized scope is refused", async () => {
      const person = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
      const issuer = await addIssuer("accepted", ["resource_estimate"]);
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, issuer);
      const claim = await createClaim("mining_right_registration");

      const response = await createCase([claim["id"] as string], person.subjectId, credential);
      expect(response.statusCode).toBe(422);
      expect(response.json().details.blockers).toEqual(["CLAIM_OUTSIDE_AUTHORITY_SCOPE"]);
      expect(response.json().details.outsideAuthorityScope).toEqual(["mining_right_registration"]);
    });

    it("the credential scope must cover every claim type, not merely be non-empty", async () => {
      const person = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
      const credential = await addCredential(person.subjectId, fx.reviewOrgA, fx.issuerAuthorityA, [
        "resource_estimate",
      ]);
      const claim = await createClaim("mining_right_registration");

      const response = await createCase([claim["id"] as string], person.subjectId, credential);
      expect(response.statusCode).toBe(422);
      expect(response.json().details.blockers).toEqual(["CREDENTIAL_SCOPE_MISMATCH"]);
    });

    it("AC-16: an issuer suspended after assignment blocks the draft", async () => {
      const person = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
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
      const person = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
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
      const otherReviewer = await addPerson("reviewer_cp_qp", fx.reviewOrgA);

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
      const replacement = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
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
      const insider = await addPerson("reviewer_cp_qp", fx.orgA);
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
      const replacement = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
      const credential = await addCredential(replacement.subjectId, fx.reviewOrgA, fx.issuerAuthorityA);
      const claim = await createClaim();
      const opened = await openCase([claim["id"] as string]);
      expect((await reassign(opened.assignmentId, replacement.subjectId, credential)).statusCode).toBe(200);

      const stale = await reassign(opened.assignmentId, fx.reviewerSubjectA, fx.credentialA);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("ASSIGNMENT_SUPERSEDED");
    });

    it("the reviewer of a signed case cannot be changed", async () => {
      const claim = await createClaim();
      const signed = await signOver([claim["id"] as string]);
      const [assignment] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.assignments WHERE case_id = ${signed.caseId}
      `;
      const response = await revokeAssignment(assignment!.id);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("CASE_NOT_REASSIGNABLE");
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

  // --- REQ-DAPP-042·044: credential status ----------------------------------

  describe("credential status", () => {
    async function freshCredential(): Promise<{ id: string; holder: Person }> {
      const holder = await addPerson("reviewer_cp_qp", fx.reviewOrgA);
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
      const response = await change(id, "revoked", steward);
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
