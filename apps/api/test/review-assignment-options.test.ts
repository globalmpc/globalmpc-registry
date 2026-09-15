import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

interface Options {
  reviewers: {
    subjectId: string;
    displayName: string;
    roles: string[];
    credentials: { id: string; credentialType: string }[];
  }[];
  schemas: { id: string; schemaKey: string; state?: string }[];
}

/**
 * Review assignment options — Q-032.
 *
 * The assignment form used to send one fixed reviewer, credential, and schema — the E2E seed's
 * ids — so on any real tenant every assignment failed. The options must be the ones an
 * assignment can actually use:
 *
 * - reviewers whose reviewer-role binding reaches this project and whose active wallet meets
 *   that role's minimum assurance — otherwise the assignee can never sign;
 * - each reviewer's currently valid credentials;
 * - active attestation schemas — a draft schema cannot be signed.
 */
describeDb("review assignment options", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { steward: string; reviewer: string; reader: string };
  const seeded = {
    lowAssurance: randomUUID(),
    revoked: randomUUID(),
    otherProjectOnly: randomUUID(),
    disabledWallet: randomUUID(),
    expiredCredential: randomUUID(),
    suspendedCredential: randomUUID(),
    draftSchema: randomUUID(),
    tenantBReviewer: randomUUID(),
    tenantBCredential: randomUUID(),
    tenantBSchema: randomUUID(),
    tenantBProject: randomUUID(),
  };

  /** A reviewer subject with one wallet and one role binding. */
  async function seedReviewer(input: {
    readonly subjectId: string;
    readonly tenantId: string;
    readonly organizationId: string;
    readonly label: string;
    readonly assurance: string;
    readonly projectId?: string;
    readonly revoked?: boolean;
    readonly walletDisabled?: boolean;
  }): Promise<void> {
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${input.subjectId}, ${input.tenantId}, 'person', ${input.label})
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, disabled_at
      ) VALUES (
        ${randomUUID()}, ${input.tenantId}, ${input.subjectId}, ${newAccount().address}, 97,
        ${input.assurance}, now(), ${input.walletDisabled ? new Date() : null}
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (
        id, tenant_id, subject_id, organization_id, project_id, role, revoked_at
      ) VALUES (
        ${randomUUID()}, ${input.tenantId}, ${input.subjectId}, ${input.organizationId},
        ${input.projectId ?? null}, 'reviewer_lab', ${input.revoked ? new Date() : null}
      )
    `;
  }

  async function seedCredential(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly subjectId: string;
    readonly status: string;
    readonly expired?: boolean;
  }): Promise<void> {
    await fx.sql`
      INSERT INTO core.credentials (
        id, tenant_id, subject_id, issuer_reference, credential_type, credential_scope,
        jurisdiction, issued_at, expires_at, current_status
      ) VALUES (
        ${input.id}, ${input.tenantId}, ${input.subjectId}, 'Test issuer', 'lab_accreditation',
        ARRAY['resource_estimate'], ARRAY['MNG'], now() - interval '2 years',
        ${input.expired ? fx.sql`now() - interval '1 day'` : fx.sql`now() + interval '1 year'`},
        ${input.status}
      )
    `;
  }

  async function seedSchema(id: string, tenantId: string, state: string): Promise<void> {
    await fx.sql`
      INSERT INTO core.attestation_schemas (
        id, tenant_id, schema_key, schema_version, attestation_type, required_evidence,
        accepted_authority_types, mandatory_limitations, jurisdiction_profile, state
      ) VALUES (
        ${id}, ${tenantId}, ${`schema-${id.slice(0, 8)}`}, '1', 'professional_signoff',
        ARRAY['mining_right_registration'], ARRAY['government_registry'],
        ARRAY['legal_effect_not_determined'], 'MNG', ${state}
      )
    `;
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    const tenantA = { tenantId: fx.tenantA, organizationId: fx.orgA };
    // Reviewer roles need high_assurance — this one can never sign.
    await seedReviewer({ ...tenantA, subjectId: seeded.lowAssurance, label: "Low Assurance Reviewer", assurance: "identity_bound" });
    await seedReviewer({ ...tenantA, subjectId: seeded.revoked, label: "Revoked Reviewer", assurance: "high_assurance", revoked: true });
    await seedReviewer({ ...tenantA, subjectId: seeded.disabledWallet, label: "Locked Reviewer", assurance: "high_assurance", walletDisabled: true });
    // A project-level binding reaches only that project.
    await seedReviewer({ ...tenantA, subjectId: seeded.otherProjectOnly, label: "Other Project Reviewer", assurance: "high_assurance", projectId: fx.otherProjectA });

    // reviewerA already holds `credentialA` (valid). An expired and a suspended one sit beside it.
    await seedCredential({ id: seeded.expiredCredential, tenantId: fx.tenantA, subjectId: fx.reviewerSubjectA, status: "valid", expired: true });
    await seedCredential({ id: seeded.suspendedCredential, tenantId: fx.tenantA, subjectId: fx.reviewerSubjectA, status: "suspended" });
    await seedSchema(seeded.draftSchema, fx.tenantA, "draft");

    // Tenant B has its own reviewer, credential, schema and project. None of it may leak.
    await seedReviewer({ tenantId: fx.tenantB, organizationId: fx.orgB, subjectId: seeded.tenantBReviewer, label: "Tenant B Reviewer", assurance: "high_assurance" });
    await seedCredential({ id: seeded.tenantBCredential, tenantId: fx.tenantB, subjectId: seeded.tenantBReviewer, status: "valid" });
    await seedSchema(seeded.tenantBSchema, fx.tenantB, "active");
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${seeded.tenantBProject}, ${fx.tenantB}, ${`B-${seeded.tenantBProject.slice(0, 8)}`},
        'Tenant B project', 'MNG', ARRAY['gold'], ${fx.orgB}
      )
    `;

    tokens = {
      steward: await signIn(app, fx.stewardA),
      reviewer: await signIn(app, fx.reviewerA),
      reader: await signIn(app, fx.readerA),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function read(token: string, projectId: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/review-assignment-options`,
      headers: bearer(token),
    });
  }

  async function options(projectId: string): Promise<Options> {
    const response = await read(tokens.steward, projectId);
    expect(response.statusCode).toBe(200);
    return response.json() as Options;
  }

  function reviewerIds(value: Options): string[] {
    return value.reviewers.map((reviewer) => reviewer.subjectId);
  }

  it("lists reviewers who can sign here, with only their currently valid credentials", async () => {
    const value = await options(fx.projectA);

    const reviewer = value.reviewers.find((item) => item.subjectId === fx.reviewerSubjectA);
    expect(reviewer).toBeDefined();
    expect(reviewer!.displayName).toBe("Reviewer A");
    expect(reviewer!.roles).toEqual(["reviewer_cp_qp"]);
    expect(reviewer!.credentials.map((credential) => credential.id)).toEqual([fx.credentialA]);
  });

  it("excludes reviewers who could not sign on this project", async () => {
    const ids = reviewerIds(await options(fx.projectA));

    expect(ids).not.toContain(seeded.lowAssurance);
    expect(ids).not.toContain(seeded.revoked);
    expect(ids).not.toContain(seeded.disabledWallet);
    expect(ids).not.toContain(seeded.otherProjectOnly);

    // The project-level binding does reach its own project.
    expect(reviewerIds(await options(fx.otherProjectA))).toContain(seeded.otherProjectOnly);
  });

  it("lists only active attestation schemas", async () => {
    const schemaIds = (await options(fx.projectA)).schemas.map((schema) => schema.id);

    expect(schemaIds).toContain(fx.schemaA);
    expect(schemaIds).not.toContain(seeded.draftSchema);
  });

  it("never returns another tenant's reviewers, credentials, or schemas", async () => {
    const value = await options(fx.projectA);
    const credentialIds = value.reviewers.flatMap((reviewer) =>
      reviewer.credentials.map((credential) => credential.id),
    );

    expect(reviewerIds(value)).not.toContain(seeded.tenantBReviewer);
    expect(credentialIds).not.toContain(seeded.tenantBCredential);
    expect(value.schemas.map((schema) => schema.id)).not.toContain(seeded.tenantBSchema);

    // Naming another tenant's project does not open its options either.
    const foreign = await read(tokens.steward, seeded.tenantBProject);
    expect([403, 404]).toContain(foreign.statusCode);
  });

  it("is read only by someone who can create the assignment", async () => {
    // Same action as creating a case (`claim.curate`). Reviewers and role-less sessions do not
    // assign, so they have no reason to browse other reviewers' credentials.
    for (const token of [tokens.reviewer, tokens.reader]) {
      const response = await read(token, fx.projectA);
      expect(response.statusCode).toBe(403);
    }
  });

  it("an assignment built from the options is accepted", async () => {
    const value = await options(fx.projectA);
    const reviewer = value.reviewers.find((item) => item.subjectId === fx.reviewerSubjectA)!;

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { ...bearer(tokens.steward), "idempotency-key": idempotencyKey() },
      payload: {
        claimType: "resource_estimate",
        valueText: "1200.5",
        unit: "kt",
        sourceCoordinate: { page: "12" },
      },
    });
    expect(claim.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/verification-cases",
      headers: { ...bearer(tokens.steward), "idempotency-key": idempotencyKey() },
      payload: {
        projectId: fx.projectA,
        schemaId: value.schemas.find((schema) => schema.id === fx.schemaA)!.id,
        claimIds: [claim.json().id],
        reviewerSubjectId: reviewer.subjectId,
        credentialId: reviewer.credentials[0]!.id,
        conflictStatus: "none",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().state).toBe("assigned");
  });
});
