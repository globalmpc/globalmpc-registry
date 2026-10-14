import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { verifyMerkleProof, type Hex } from "@mpc/canonical";
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

    // From R1, auth is SIWE signature → session token. Tests follow the same path.
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
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${fx.tenantA}, ${projectKey}, 'Registry fixture', 'MNG',
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
          id, tenant_id, project_id, connection_id, authority_id, collection_method,
          result, query_basis, endpoint_or_document_ref, authentication_method,
          raw_hash, source_schema_version, adapter_version, terms_license,
          commercial_reuse, disclosure_permission, received_at, as_of,
          freshness_status, correlation_id
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${projectId}, ${fx.connectionA}, ${fx.authorityA},
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
      INSERT INTO core.verification_cases (id, tenant_id, project_id, schema_id, state)
      VALUES (${caseId}, ${fx.tenantA}, ${projectId}, ${fx.schemaA}, 'draft')
    `;
    const assignmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.assignments (id, tenant_id, case_id, subject_id, credential_id)
      VALUES (${assignmentId}, ${fx.tenantA}, ${caseId}, ${fx.reviewerSubjectA}, ${fx.credentialA})
    `;
    const claimId = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, tenant_id, project_id, claim_type, value_text, source_coordinate, grade
      ) VALUES (
        ${claimId}, ${fx.tenantA}, ${projectId}, 'mining_right', 'MN-1', '{"page":"1"}'::jsonb,
        'verified'
      )
    `;
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_attestations (
        id, tenant_id, case_id, assignment_id, credential_id, schema_id,
        attestation_type, claim_scope, evidence_snapshot_hash, findings, limitations,
        credential_status_snapshot, method_version, policy_version,
        payload_hash, signature, signer_wallet_address, signed_at, state
      ) VALUES (
        ${id}, ${fx.tenantA}, ${caseId}, ${assignmentId}, ${fx.credentialA}, ${fx.schemaA},
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

    it("the drafting role cannot publish", async () => {
      const drafted = await draft(tokens.operatorA);
      const response = await publishDraft(app, tokens.operatorA, drafted.json());
      expect(response.statusCode).toBe(403);
      expect(response.json().details.requiredRoles).toContain("disclosure_approver");
    });

    it("a person holding both roles cannot publish their own draft", async () => {
      const [approver] = await fx.sql<{ subject_id: string }[]>`
        SELECT subject_id FROM core.wallet_identities
        WHERE wallet_address = ${fx.disclosureApproverA.address}
      `;
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${approver!.subject_id}, ${fx.orgA}, 'mpc_operator')
      `;
      try {
        const both = await signIn(app, fx.disclosureApproverA);
        const drafted = await draft(both);
        expect(drafted.statusCode).toBe(200);

        const response = await publishDraft(app, both, drafted.json());
        expect(response.statusCode).toBe(422);
        expect(response.json().code).toBe("REGISTRY_DRAFT_SELF_PUBLICATION");
      } finally {
        await fx.sql`
          UPDATE core.role_bindings SET revoked_at = now()
          WHERE subject_id = ${approver!.subject_id} AND role = 'mpc_operator'
        `;
      }
    });

    it("the database refuses publication by the drafter", async () => {
      const drafted = (await draft(tokens.operatorA)).json();
      const published = (await publish(tokens.operatorA)).json();
      await expect(
        fx.sql`
          UPDATE core.registry_publication_drafts
          SET state = 'published', decided_by_subject_id = proposed_by_subject_id,
              decided_at = now(), entry_version_id = ${published.id}
          WHERE id = ${drafted.id}
        `,
      ).rejects.toThrow(/registry_draft_two_person/);
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

    it("another tenant's pending draft for the same key does not block this tenant's draft", async () => {
      const publicKey = `XT-${randomUUID().slice(0, 8)}`;
      const otherProject = randomUUID();
      await fx.sql`
        INSERT INTO core.projects (
          id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
        ) VALUES (
          ${otherProject}, ${fx.tenantB}, ${publicKey}, 'Other tenant', 'MNG', ARRAY['copper'],
          ${fx.orgB}
        )
      `;
      const otherDraft = await draft(await signIn(app, fx.operatorB), {
        publicKey,
        subjectId: otherProject,
      });
      expect(otherDraft.statusCode).toBe(200);

      // Tenant A cannot see B's draft, so a refusal pointing at it could not be acted on.
      const ours = await draft(tokens.operatorA, { publicKey });
      expect(ours.statusCode).toBe(200);
    });

    /**
     * The public URL is `/registries/{type}/{publicKey}` with no tenant in it, so a key is unique
     * across tenants. Another tenant's entry is invisible under RLS, so the publish route's own
     * lookup misses it and the INSERT hits the unique constraint. That is the same conflict as a
     * key held by another subject in this tenant, and it must read the same — the answer may not
     * reveal that another tenant holds the key.
     */
    it("a key another tenant already published is refused with the same 409 as in-tenant", async () => {
      const publicKey = `XTP-${randomUUID().slice(0, 8)}`;
      const otherProject = randomUUID();
      await fx.sql`
        INSERT INTO core.projects (
          id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
        ) VALUES (
          ${otherProject}, ${fx.tenantB}, ${publicKey}, 'Other tenant', 'MNG', ARRAY['copper'],
          ${fx.orgB}
        )
      `;
      await fx.sql`
        INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
        VALUES (${randomUUID()}, ${fx.tenantB}, 'project', ${otherProject}, ${publicKey})
      `;

      const drafted = await draft(tokens.operatorA, { publicKey });
      expect(drafted.statusCode).toBe(200);
      const response = await publishDraft(app, tokens.disclosureApproverA, drafted.json());

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "REGISTRY_KEY_TAKEN",
        message: "This public key belongs to another subject",
        retryable: false,
      });
      expect(response.json().details).toBeUndefined();
    });

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
          id, tenant_id, project_id, claim_type, value_text, source_coordinate
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${projectsByKey.get(publicKey)!}, 'mining_right',
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
        payload: {},
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

    it("resets the attempt count of a stuck batch and resubmits", async () => {
      const batchId = await makeBatch();
      await fx.sql`
        UPDATE chain.transactions
        SET state = 'dropped', attempts = 3, tx_hash = ${`0x${"ab".repeat(32)}`}
        WHERE batch_id = ${batchId}
      `;

      const response = await resubmit(batchId);
      expect(response.statusCode).toBe(200);
      expect(response.json().previousState).toBe("dropped");

      const [row] = await fx.sql<{ state: string; attempts: number; tx_hash: string | null }[]>`
        SELECT state, attempts, tx_hash FROM chain.transactions WHERE batch_id = ${batchId}
      `;
      // A person checked the cause and decided, so it does not inherit the previous attempt cap.
      expect(row!.state).toBe("created");
      expect(row!.attempts).toBe(0);
      expect(row!.tx_hash).toBeNull();
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
    expect(response.json().details.requiredRoles).toContain("mpc_operator");
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

    it("response has no information that identifies the tenant", async () => {
      const publicKey = `PUB-${randomUUID().slice(0, 8)}`;
      await publish(tokens.operatorA, { publicKey });

      const body = (
        await app.inject({
          method: "GET",
          url: `/api/v1/public/registries/project/${publicKey}`,
        })
      ).json();

      expect(JSON.stringify(body)).not.toContain(fx.tenantA);
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
    it("builds a batch from published versions", async () => {
      await publish(tokens.operatorA);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.recordCount).toBeGreaterThan(0);
      expect(body.root).toMatch(/^0x[0-9a-f]{64}$/);
      // Not on chain yet.
      expect(body.confirmationState).toBe("created");
    });

    it("does not create an empty batch when nothing is pending", async () => {
      // Everything was anchored in the previous test.
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/anchor-batches",
        headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ANCHOR_BATCH_EMPTY");
    });

    it("concurrent batch requests do not anchor the same version twice", async () => {
      // Both requests see the same unanchored versions. Without serialization both build a batch
      // from them, and one version ends up in two roots — its inclusion becomes ambiguous.
      const published = (await publish(tokens.operatorA, { publicKey: `CON-${randomUUID().slice(0, 8)}` })).json();
      const create = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/anchor-batches",
          headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
          payload: {},
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
          id, tenant_id, batch_id, merkle_root, manifest_hash,
          manifest_object_key, schema_version, record_count
        ) VALUES (
          ${otherBatch}, ${fx.tenantA}, ${`0x${otherBatch.replace(/-/g, "").repeat(2)}`},
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
        payload: {},
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
        payload: {},
      });

      const proof = (
        await app.inject({ method: "GET", url: `/api/v1/public/proofs/${published.id}` })
      ).json();

      // Returns the value given at publication — not a hard-coded constant.
      expect(proof.policyVersion).toBe("mn-core-9.9.9");
      expect(proof.schemaVersion).toBe("project-registry-9");
      expect(proof.serializationVersion).toBe("1");

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
        payload: {},
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
        payload: {},
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
      await publish(tokens.operatorA);
      const batch = (
        await app.inject({
          method: "POST",
          url: "/api/v1/anchor-batches",
          headers: {
            authorization: `Bearer ${tokens.operatorA}`,
            "idempotency-key": idempotencyKey(),
          },
          payload: {},
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
