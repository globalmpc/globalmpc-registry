import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { bootstrapOperator } from "../src/bootstrap.js";
import {
  bootstrapAttestationSchema,
  bootstrapCredential,
  bootstrapPolicySet,
} from "../src/bootstrap-registry.js";
import {
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  type TestFixture,
} from "./helpers/db.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Review registry proposals — spec 02 §2.8, W-066 / Q-020.
 *
 * Credentials, attestation schemas and compliance policy sets used to be created only by an
 * operator CLI, where "approval" was a name the operator typed. This file guards the path that
 * replaces it:
 *
 * 1. **Proposing creates nothing.** A registry row appears only when someone else approves.
 * 2. **The proposer never approves** — not through the route, not by writing to the table.
 * 3. **Approval produces the same row the bootstrap CLI writes**, so readiness and signing
 *    cannot tell the two paths apart.
 */

const BASE = "/api/v1/review-registry";

type Proposal = {
  id: string;
  kind: string;
  itemKey: string;
  itemVersion: number;
  state: string;
  materializedId: string | null;
  version: number;
  proposedBySubjectId: string;
  decidedBySubjectId: string | null;
};

describeDb("review registry proposals", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let approverToken: string;
  let approverSubject: string;
  let dualToken: string;
  let stewardToken: string;
  let operatorBToken: string;

  /** Inserts a person with the given roles in tenant A. Returns the subject id. */
  async function addPerson(
    label: string,
    roles: readonly string[],
    account: TestAccount,
  ): Promise<string> {
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', ${label})
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${account.address}, 97, 'high_assurance', now()
      )
    `;
    for (const role of roles) {
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, ${role})
      `;
    }
    return subjectId;
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    const approver = newAccount();
    approverSubject = await addPerson("Assurance Reviewer A", ["reviewer_assurance"], approver);
    // One person holding both roles. Only the person check can stop them approving their own work.
    const dual = newAccount();
    await addPerson("Operator and Reviewer A", ["mpc_operator", "reviewer_assurance"], dual);

    operatorToken = await signIn(app, fx.operatorA);
    approverToken = await signIn(app, approver);
    dualToken = await signIn(app, dual);
    stewardToken = await signIn(app, fx.stewardA);
    operatorBToken = await signIn(app, fx.operatorB);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function post(token: string, url: string, payload: unknown, ifMatch?: number) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        ...(ifMatch !== undefined ? { "if-match": `"${ifMatch}"` } : {}),
      },
      payload: payload as never,
    });
  }

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  function ruleSet(overrides: Record<string, unknown> = {}) {
    return { ...rulesFixture, ruleSetId: `api-${randomUUID().slice(0, 8)}`, ...overrides };
  }

  function schemaBody(overrides: Record<string, unknown> = {}) {
    return {
      schemaKey: `api-schema-${randomUUID().slice(0, 8)}`,
      schemaVersion: "1",
      attestationType: "professional_signoff",
      requiredEvidence: ["mining_right_registration"],
      acceptedAuthorityTypes: ["government_registry"],
      mandatoryLimitations: ["Does not include a site visit"],
      jurisdictionProfile: "MNG",
      effectiveFrom: "2026-01-01T00:00:00Z",
      rationale: "Mining right review needs a signed schema",
      ...overrides,
    };
  }

  function credentialBody(subjectId: string, overrides: Record<string, unknown> = {}) {
    return {
      subjectId,
      issuerReference: `AusIMM #${randomUUID().slice(0, 8)}`,
      credentialType: "competent_person",
      credentialScope: ["mining_right_registration"],
      jurisdiction: ["MNG"],
      issuedAt: "2024-01-01T00:00:00Z",
      expiresAt: "2031-01-01T00:00:00Z",
      rationale: "Membership confirmed against the issuer register",
      ...overrides,
    };
  }

  async function proposePolicy(definition: unknown, token = operatorToken): Promise<Proposal> {
    const response = await post(token, `${BASE}/policy-sets/proposals`, {
      definition,
      rationale: "Registry publication gate for the pilot",
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Proposal;
  }

  async function decide(
    token: string,
    segment: string,
    proposal: Proposal,
    decision: "approve" | "reject" = "approve",
  ) {
    return post(
      token,
      `${BASE}/${segment}/proposals/${proposal.id}/decision`,
      { decision, reason: decision === "approve" ? "Reviewed against the spec" : "Not ready" },
      proposal.version,
    );
  }

  describe("proposal and approval are separate acts", () => {
    it("proposing a policy set creates no policy set", async () => {
      const definition = ruleSet();
      const proposal = await proposePolicy(definition);

      expect(proposal.state).toBe("pending");
      expect(proposal.kind).toBe("policy_set");
      expect(proposal.itemKey).toBe(definition.ruleSetId);
      expect(proposal.itemVersion).toBe(1);
      expect(proposal.materializedId).toBeNull();

      const rows = await fx.sql`
        SELECT id FROM core.compliance_policy_sets
        WHERE tenant_id = ${fx.tenantA} AND rule_set_id = ${definition.ruleSetId}
      `;
      expect(rows).toHaveLength(0);
    });

    it("another person's approval materializes an effective policy set", async () => {
      const proposal = await proposePolicy(ruleSet());
      const decided = await decide(approverToken, "policy-sets", proposal);

      expect(decided.statusCode, decided.body).toBe(200);
      expect(decided.json().state).toBe("approved");
      expect(decided.headers["etag"]).toBe(`"${proposal.version + 1}"`);

      const [row] = await fx.sql<{ state: string }[]>`
        SELECT state FROM core.compliance_policy_sets WHERE id = ${decided.json().materializedId}
      `;
      expect(row?.state).toBe("effective");
    });

    it("a rejection materializes nothing", async () => {
      const definition = ruleSet();
      const proposal = await proposePolicy(definition);
      const decided = await decide(approverToken, "policy-sets", proposal, "reject");

      expect(decided.statusCode).toBe(200);
      expect(decided.json().state).toBe("rejected");
      expect(decided.json().materializedId).toBeNull();
      const rows = await fx.sql`
        SELECT id FROM core.compliance_policy_sets
        WHERE tenant_id = ${fx.tenantA} AND rule_set_id = ${definition.ruleSetId}
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("the proposer never approves", () => {
    it("rejects self-approval even when the proposer holds the approver role", async () => {
      const proposal = await proposePolicy(ruleSet(), dualToken);
      const self = await decide(dualToken, "policy-sets", proposal);

      expect(self.statusCode).toBe(422);
      expect(self.json().code).toBe("REGISTRY_PROPOSAL_SELF_APPROVAL");
    });

    it("the DB rejects self-approval written straight to the table", async () => {
      const proposal = await proposePolicy(ruleSet());

      // The application role, with RLS on — the same connection the API uses.
      await expect(
        fx.appSql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await tx`
            UPDATE core.registry_proposals
            SET state = 'approved', decided_by_subject_id = proposed_by_subject_id,
                decided_at = now(), decision_reason = 'approving my own', materialized_id = ${randomUUID()}
            WHERE id = ${proposal.id}
          `;
        }),
      ).rejects.toThrow(/registry_proposal_two_person/);
    });

    it("the DB does not accept a proposal inserted as already decided", async () => {
      await expect(
        fx.sql`
          INSERT INTO core.registry_proposals (
            id, tenant_id, kind, item_key, item_version, payload, rationale, effective_from,
            proposed_by_subject_id, state, decided_by_subject_id, decided_at, decision_reason,
            materialized_id
          ) VALUES (
            ${randomUUID()}, ${fx.tenantA}, 'policy_set', 'forged', 1, '{}'::jsonb, 'forged',
            now(), ${fx.operatorSubjectA}, 'approved', ${approverSubject}, now(), 'forged',
            ${randomUUID()}
          )
        `,
      ).rejects.toThrow(/must be proposed as pending/);
    });
  });

  describe("authorization", () => {
    it("an operator cannot approve — approval belongs to the designated review role", async () => {
      const proposal = await proposePolicy(ruleSet());
      const response = await decide(operatorToken, "policy-sets", proposal);

      expect(response.statusCode).toBe(403);
      expect(response.json().details.requiredRoles).toContain("reviewer_assurance");
      expect(response.json().details.requiredRoles).not.toContain("mpc_operator");
    });

    it("a data steward cannot propose", async () => {
      const response = await post(stewardToken, `${BASE}/policy-sets/proposals`, {
        definition: ruleSet(),
        rationale: "steward attempt",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().details.requiredRoles).toContain("mpc_operator");
    });

    it("a steward cannot read proposals either", async () => {
      const response = await get(stewardToken, `${BASE}/policy-sets/proposals`);
      expect(response.statusCode).toBe(403);
    });
  });

  describe("validation", () => {
    it("rejects a rule set that fails the policy schema with 422", async () => {
      const response = await post(operatorToken, `${BASE}/policy-sets/proposals`, {
        definition: ruleSet({ version: "1" }),
        rationale: "not semver",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("POLICY_SET_INVALID");
    });

    it("rejects a schema without mandatory limitations (AC-01)", async () => {
      const response = await post(
        operatorToken,
        `${BASE}/attestation-schemas/proposals`,
        schemaBody({ mandatoryLimitations: [] }),
      );

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ATTESTATION_SCHEMA_INVALID");
    });

    it("rejects an already expired credential", async () => {
      const response = await post(
        operatorToken,
        `${BASE}/credentials/proposals`,
        credentialBody(fx.reviewerSubjectA, { expiresAt: "2020-01-01T00:00:00Z" }),
      );

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CREDENTIAL_INVALID");
    });

    it("rejects a blank rationale at the route", async () => {
      const response = await post(operatorToken, `${BASE}/policy-sets/proposals`, {
        definition: ruleSet(),
        rationale: "   ",
      });
      expect(response.statusCode).toBe(400);
    });

    it("the DB rejects a blank rationale", async () => {
      await expect(
        fx.sql`
          INSERT INTO core.registry_proposals (
            id, tenant_id, kind, item_key, item_version, payload, rationale, effective_from,
            proposed_by_subject_id
          ) VALUES (
            ${randomUUID()}, ${fx.tenantA}, 'policy_set', ${`blank-${randomUUID()}`}, 1,
            '{}'::jsonb, '   ', now(), ${fx.operatorSubjectA}
          )
        `,
      ).rejects.toThrow(/registry_proposals_rationale_check/);
    });

    it("allows only one pending proposal per item", async () => {
      const definition = ruleSet();
      await proposePolicy(definition);
      const second = await post(operatorToken, `${BASE}/policy-sets/proposals`, {
        definition: { ...definition, version: "1.0.1" },
        rationale: "second pending",
      });

      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("REGISTRY_PROPOSAL_PENDING");
    });

    it("rejects a decision on a stale version with 412", async () => {
      const proposal = await proposePolicy(ruleSet());
      const response = await post(
        approverToken,
        `${BASE}/policy-sets/proposals/${proposal.id}/decision`,
        { decision: "approve", reason: "stale" },
        proposal.version + 5,
      );
      expect(response.statusCode).toBe(412);
    });
  });

  describe("versions", () => {
    it("the next version gets the next item version and leaves the first untouched", async () => {
      const first = ruleSet();
      const v1 = await proposePolicy(first);
      const approvedV1 = (await decide(approverToken, "policy-sets", v1)).json() as Proposal;

      const snapshot = async (id: string) =>
        (
          await fx.sql<{ row: unknown }[]>`
            SELECT to_jsonb(p) AS row FROM core.compliance_policy_sets p WHERE id = ${id}
          `
        )[0]?.row;
      const rowBefore = await snapshot(approvedV1.materializedId!);
      const proposalBefore = (await get(approverToken, `${BASE}/policy-sets/proposals/${v1.id}`)).json();

      const v2 = await proposePolicy({ ...first, version: "1.1.0" });
      expect(v2.itemKey).toBe(first.ruleSetId);
      expect(v2.itemVersion).toBe(2);
      const approvedV2 = (await decide(approverToken, "policy-sets", v2)).json() as Proposal;

      expect(approvedV2.materializedId).not.toBe(approvedV1.materializedId);
      expect(await snapshot(approvedV1.materializedId!)).toEqual(rowBefore);

      const proposalAfter = (await get(approverToken, `${BASE}/policy-sets/proposals/${v1.id}`)).json();
      expect({ ...proposalAfter, requestId: null, asOf: null }).toEqual({
        ...proposalBefore,
        requestId: null,
        asOf: null,
      });
    });

    it("a decided proposal cannot be changed or deleted, even by a superuser", async () => {
      const proposal = await proposePolicy(ruleSet());
      await decide(approverToken, "policy-sets", proposal);

      await expect(
        fx.sql`UPDATE core.registry_proposals SET rationale = 'rewritten' WHERE id = ${proposal.id}`,
      ).rejects.toThrow(/cannot be modified/);
      await expect(
        fx.sql`DELETE FROM core.registry_proposals WHERE id = ${proposal.id}`,
      ).rejects.toThrow(/cannot be deleted/);
    });

    it("a proposal already registered under the same version label is refused up front", async () => {
      const definition = ruleSet();
      const v1 = await proposePolicy(definition);
      await decide(approverToken, "policy-sets", v1);

      const again = await post(operatorToken, `${BASE}/policy-sets/proposals`, {
        definition,
        rationale: "same label again",
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("REGISTRY_ITEM_EXISTS");
    });
  });

  describe("tenant isolation", () => {
    it("another tenant cannot list, read or decide the proposal", async () => {
      const proposal = await proposePolicy(ruleSet());

      const listed = (await get(operatorBToken, `${BASE}/policy-sets/proposals`)).json() as {
        items: Proposal[];
      };
      expect(listed.items.map((item) => item.id)).not.toContain(proposal.id);

      const read = await get(operatorBToken, `${BASE}/policy-sets/proposals/${proposal.id}`);
      expect(read.statusCode).toBe(404);

      const rows = await fx.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${fx.tenantB}, true)`;
        return tx`SELECT id FROM core.registry_proposals WHERE id = ${proposal.id}`;
      });
      expect(rows).toHaveLength(0);
    });
  });

  describe("audit", () => {
    it("records proposal, approval and materialization with the effective role", async () => {
      const proposal = await proposePolicy(ruleSet());
      const decided = (await decide(approverToken, "policy-sets", proposal)).json() as Proposal;

      const events = await fx.sql<{ command: string; effective_role: string; resource_id: string }[]>`
        SELECT command, effective_role, resource_id FROM audit.events
        WHERE resource_id IN (${proposal.id}, ${decided.materializedId!})
        ORDER BY occurred_at, command
      `;
      const byCommand = Object.fromEntries(events.map((event) => [event.command, event]));

      expect(byCommand["review_registry.policy_set.proposed"]?.effective_role).toBe("mpc_operator");
      expect(byCommand["review_registry.policy_set.approved"]?.effective_role).toBe("reviewer_assurance");
      expect(byCommand["review_registry.policy_set.materialized"]?.resource_id).toBe(
        decided.materializedId,
      );
    });
  });

  describe("readiness", () => {
    it("evaluates readiness with a policy set created through the API", async () => {
      const proposal = await proposePolicy(ruleSet());
      const decided = (await decide(approverToken, "policy-sets", proposal)).json() as Proposal;

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/readiness-assessments`,
        headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
        payload: { policySetId: decided.materializedId },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(["ok", "watch", "gap", "not_evaluable"]).toContain(response.json().status);
      expect(response.json().policySetId).toBe(decided.materializedId);
    });
  });

  describe("credentials and schemas", () => {
    it("an approved credential is valid and carries the holder's organization", async () => {
      const response = await post(
        operatorToken,
        `${BASE}/credentials/proposals`,
        credentialBody(fx.reviewerSubjectA),
      );
      expect(response.statusCode, response.body).toBe(200);
      const decided = (await decide(approverToken, "credentials", response.json())).json() as Proposal;

      const [row] = await fx.sql<{ current_status: string; subject_id: string; organization_id: string }[]>`
        SELECT current_status, subject_id, organization_id FROM core.credentials
        WHERE id = ${decided.materializedId}
      `;
      expect(row).toEqual({
        current_status: "valid",
        subject_id: fx.reviewerSubjectA,
        organization_id: fx.orgA,
      });
    });

    it("the holder cannot approve their own credential", async () => {
      const response = await post(
        operatorToken,
        `${BASE}/credentials/proposals`,
        credentialBody(approverSubject),
      );
      const self = await decide(approverToken, "credentials", response.json());

      expect(self.statusCode).toBe(422);
      expect(self.json().code).toBe("REGISTRY_CREDENTIAL_SELF_APPROVAL");
    });

    it("does not attach a credential to a subject outside the tenant", async () => {
      const response = await post(
        operatorToken,
        `${BASE}/credentials/proposals`,
        credentialBody(randomUUID()),
      );
      expect(response.statusCode).toBe(404);
    });

    it("an approved schema is active", async () => {
      const response = await post(operatorToken, `${BASE}/attestation-schemas/proposals`, schemaBody());
      expect(response.statusCode, response.body).toBe(200);
      const decided = (
        await decide(approverToken, "attestation-schemas", response.json())
      ).json() as Proposal;

      const [row] = await fx.sql<{ state: string }[]>`
        SELECT state FROM core.attestation_schemas WHERE id = ${decided.materializedId}
      `;
      expect(row?.state).toBe("active");
    });
  });

  /**
   * Both paths write through the same materialization function.
   *
   * Compared as whole rows minus identity columns, so a column one path fills and the other
   * leaves to a default shows up here instead of in a signing check months later.
   */
  describe("bootstrap and API approval produce identical rows", () => {
    let bootstrapSlug: string;
    let bootstrapWallet: string;

    beforeAll(async () => {
      bootstrapSlug = `rr-${randomUUID().slice(0, 8)}`;
      bootstrapWallet = newAccount().address;
      await bootstrapOperator(fx.sql, {
        tenantSlug: bootstrapSlug,
        tenantName: "Review registry parity tenant",
        organizationName: "Parity org",
        jurisdiction: "MNG",
        subjectName: "Parity reviewer",
        walletAddress: bootstrapWallet,
        chainId: 97,
        role: "reviewer_cp_qp",
        assuranceLevel: "high_assurance",
      });
    });

    const IDENTITY = ["id", "tenant_id", "created_at"] as const;

    async function rowOf(table: string, id: string, extra: readonly string[] = []) {
      const [row] = await fx.sql<{ row: Record<string, unknown> }[]>`
        SELECT to_jsonb(t) AS row FROM ${fx.sql(table)} t WHERE id = ${id}
      `;
      const copy = { ...row!.row };
      for (const column of [...IDENTITY, ...extra]) delete copy[column];
      return copy;
    }

    it("policy set", async () => {
      const definition = ruleSet();
      const viaBootstrap = await bootstrapPolicySet(fx.sql, {
        tenantSlug: bootstrapSlug,
        definition,
        approvedBy: "Verification lead",
      });
      const viaApi = (
        await decide(approverToken, "policy-sets", await proposePolicy(definition))
      ).json() as Proposal;

      expect(await rowOf("core.compliance_policy_sets", viaApi.materializedId!)).toEqual(
        await rowOf("core.compliance_policy_sets", viaBootstrap.id),
      );
    });

    it("attestation schema", async () => {
      const body = schemaBody();
      const viaBootstrap = await bootstrapAttestationSchema(fx.sql, {
        tenantSlug: bootstrapSlug,
        schemaKey: body.schemaKey,
        schemaVersion: body.schemaVersion,
        attestationType: body.attestationType,
        requiredEvidence: body.requiredEvidence,
        acceptedAuthorityTypes: body.acceptedAuthorityTypes,
        mandatoryLimitations: body.mandatoryLimitations,
        jurisdictionProfile: body.jurisdictionProfile,
        approvedBy: "Verification lead",
      });
      const proposed = await post(operatorToken, `${BASE}/attestation-schemas/proposals`, body);
      const viaApi = (
        await decide(approverToken, "attestation-schemas", proposed.json())
      ).json() as Proposal;

      expect(await rowOf("core.attestation_schemas", viaApi.materializedId!)).toEqual(
        await rowOf("core.attestation_schemas", viaBootstrap.id),
      );
    });

    it("credential", async () => {
      const body = credentialBody(fx.reviewerSubjectA);
      const viaBootstrap = await bootstrapCredential(fx.sql, {
        tenantSlug: bootstrapSlug,
        walletAddress: bootstrapWallet,
        issuerReference: body.issuerReference,
        credentialType: body.credentialType,
        credentialScope: body.credentialScope,
        jurisdiction: body.jurisdiction,
        issuedAt: body.issuedAt,
        expiresAt: body.expiresAt,
      });
      const proposed = await post(operatorToken, `${BASE}/credentials/proposals`, body);
      const viaApi = (await decide(approverToken, "credentials", proposed.json())).json() as Proposal;

      // Holder and organization are tenant-bound identities; everything else must match.
      const holder = ["subject_id", "organization_id"];
      expect(await rowOf("core.credentials", viaApi.materializedId!, holder)).toEqual(
        await rowOf("core.credentials", viaBootstrap.id, holder),
      );
    });
  });
});
