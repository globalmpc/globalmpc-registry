import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Readiness reads its inputs from the project — REQ-DAPP-007, REQ-DAPP-026, REQ-DAPP-047,
 * REQ-DAPP-055, AC-04, AC-25.
 *
 * The assessment context used to be constants (stage, reporting standard, one country's
 * environmental law, an approved profile, no offering, no expiring rights), and the grade was
 * the project-wide minimum. Each test here uses its own project so one test's claims do not
 * decide another's result.
 */
describeDb("readiness inputs come from project data", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let fixturePolicy: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    fixturePolicy = await policy(rulesFixture);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function policy(definition: unknown): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${id}, ${fx.tenantA}, ${`rules-${id.slice(0, 8)}`}, '1.0.0', 'registry_publication',
        'MNG', now(), ${fx.sql.json(definition as never)}, 'effective'
      )
    `;
    return id;
  }

  /** A rule set with one requirement, for tests that need a single moving part. */
  function singleRule(requirement: Record<string, unknown>) {
    return {
      ...rulesFixture,
      requirements: [
        {
          requirementId: "only",
          label: "Only requirement",
          appliesWhen: { op: "always" },
          requiredClaimTypes: ["mining_right_registration"],
          minimumGrade: "unverified",
          freshnessThresholdDays: null,
          requiredAttestations: [],
          blockingConflictTypes: [],
          notEvaluableWhen: { op: "never" },
          watchWhen: null,
          ...requirement,
        },
      ],
    };
  }

  async function newProject(): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${id}, ${fx.tenantA}, ${`DER-${id.slice(0, 8)}`}, 'Derived inputs', 'MNG',
        ARRAY['copper'], ${fx.orgA}
      )
    `;
    return id;
  }

  async function claim(
    projectId: string,
    claimType: string,
    options: { value?: string; grade?: string; asOf?: string | null; staleSince?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, tenant_id, project_id, claim_type, value_text, as_of, source_coordinate, grade,
        stale_since, stale_reason
      ) VALUES (
        ${id}, ${fx.tenantA}, ${projectId}, ${claimType}, ${options.value ?? "recorded"},
        ${options.asOf === undefined ? "2026-09-01" : options.asOf},
        ${fx.sql.json({ document: "extract" })}, ${options.grade ?? "verified"},
        ${options.staleSince ?? null},
        ${options.staleSince ? "Source connection became disabled" : null}
      )
    `;
    return id;
  }

  async function assess(projectId: string, policySetId: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/readiness-assessments`,
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: { policySetId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      status: string;
      inputSnapshotHash: string;
      requirementResults: {
        requirementId: string;
        status: string;
        applicable: boolean;
        reasonCode: string;
        missing: string[];
        nextAction: string | null;
      }[];
    };
    return {
      body,
      result: (id: string) => body.requirementResults.find((r) => r.requirementId === id)!,
    };
  }

  describe("no default stands in for an unrecorded fact", () => {
    it("jurisdiction profile facts are not borrowed — the requirements reading them are not_evaluable", async () => {
      const projectId = await newProject();
      const { result } = await assess(projectId, fixturePolicy);

      expect(result("mining-right").status).toBe("not_evaluable");
      expect(result("mining-right").missing).toContain("fact:jurisdictionProfileState");
      expect(result("environmental-baseline").status).toBe("not_evaluable");
      expect(result("environmental-baseline").missing).toEqual(["fact:environmentalRequirementBasis"]);
      expect(result("mining-right").nextAction).toBeTruthy();
    });

    it("no recorded project stage — whether the estimate requirement applies is unknown", async () => {
      const projectId = await newProject();
      const { result } = await assess(projectId, fixturePolicy);
      expect(result("resource-estimate").applicable).toBe(true);
      expect(result("resource-estimate").status).toBe("not_evaluable");
      expect(result("resource-estimate").missing).toEqual(["fact:projectStage"]);
    });

    it("a recorded stage decides applicability", async () => {
      const early = await newProject();
      await claim(early, "project_stage", { value: "grassroots" });
      expect((await assess(early, fixturePolicy)).result("resource-estimate").applicable).toBe(false);

      const later = await newProject();
      await claim(later, "project_stage", { value: "exploration_or_later" });
      const estimate = (await assess(later, fixturePolicy)).result("resource-estimate");
      expect(estimate.applicable).toBe(true);
      // The stage is known; the reporting standard is a jurisdiction profile value with no store.
      expect(estimate.missing).toEqual(["fact:acceptedReportingStandard"]);
    });

    it("offering intent must be recorded to rule the ERSP requirement out", async () => {
      const unknown = await newProject();
      expect((await assess(unknown, fixturePolicy)).result("ersp-linkage").status).toBe(
        "not_evaluable",
      );

      const none = await newProject();
      await claim(none, "offering_intent", { value: "false" });
      expect((await assess(none, fixturePolicy)).result("ersp-linkage").applicable).toBe(false);
    });

    it("claims that disagree are not a basis", async () => {
      const projectId = await newProject();
      await claim(projectId, "offering_intent", { value: "false" });
      await claim(projectId, "offering_intent", { value: "true" });
      expect((await assess(projectId, fixturePolicy)).result("ersp-linkage").status).toBe(
        "not_evaluable",
      );
    });

    it("rights expiry comes from the recorded expiry date against the evaluation time", async () => {
      const watchPolicy = await policy(
        singleRule({ watchWhen: { op: "eq", path: "rightsExpiryWithin12Months", value: "true" } }),
      );
      const soon = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const late = new Date(Date.now() + 800 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const unrecorded = await newProject();
      await claim(unrecorded, "mining_right_registration");
      expect((await assess(unrecorded, watchPolicy)).result("only").status).toBe("not_evaluable");

      const expiring = await newProject();
      await claim(expiring, "mining_right_registration");
      await claim(expiring, "mining_right_expiry", { value: soon });
      expect((await assess(expiring, watchPolicy)).result("only").status).toBe("watch");

      const distant = await newProject();
      await claim(distant, "mining_right_registration");
      await claim(distant, "mining_right_expiry", { value: late });
      expect((await assess(distant, watchPolicy)).result("only").status).toBe("ok");
    });

    it("AC-11: a change in a context fact changes the input snapshot hash", async () => {
      const projectId = await newProject();
      const before = await assess(projectId, fixturePolicy);
      await claim(projectId, "project_stage", { value: "exploration_or_later" });
      const after = await assess(projectId, fixturePolicy);
      expect(after.body.inputSnapshotHash).not.toBe(before.body.inputSnapshotHash);
    });
  });

  describe("REQ-DAPP-007: weakest link per requirement", () => {
    it("a weak claim of one type does not fail a requirement that never reads it", async () => {
      const twoRules = {
        ...rulesFixture,
        requirements: [
          { ...singleRule({}).requirements[0], requirementId: "rights", minimumGrade: "partially_verified" },
          {
            ...singleRule({}).requirements[0],
            requirementId: "identity",
            requiredClaimTypes: ["project_identity"],
            minimumGrade: "partially_verified",
          },
        ],
      };
      const policySetId = await policy(twoRules);
      const projectId = await newProject();
      await claim(projectId, "mining_right_registration", { grade: "verified" });
      await claim(projectId, "project_identity", { grade: "self_reported" });

      const { result } = await assess(projectId, policySetId);
      expect(result("rights").status).toBe("ok");
      expect(result("identity").status).toBe("gap");
      expect(result("identity").reasonCode).toBe("GRADE_BELOW_MINIMUM");
    });

    it("the weakest of a requirement's own claims decides it", async () => {
      const policySetId = await policy(singleRule({ minimumGrade: "partially_verified" }));
      const projectId = await newProject();
      await claim(projectId, "mining_right_registration", { grade: "verified" });
      await claim(projectId, "mining_right_registration", { grade: "unverified" });
      expect((await assess(projectId, policySetId)).result("only").reasonCode).toBe(
        "GRADE_BELOW_MINIMUM",
      );
    });

    it("evidence age is the requirement's own oldest claim; an undated claim makes it unknown", async () => {
      const policySetId = await policy(singleRule({ freshnessThresholdDays: "36500" }));
      const dated = await newProject();
      await claim(dated, "mining_right_registration", { asOf: "2026-01-01" });
      // An undated claim of another type does not make this requirement's age unknown.
      await claim(dated, "project_identity", { asOf: null });
      expect((await assess(dated, policySetId)).result("only").status).toBe("ok");

      const undated = await newProject();
      await claim(undated, "mining_right_registration", { asOf: "2026-01-01" });
      await claim(undated, "mining_right_registration", { asOf: null });
      expect((await assess(undated, policySetId)).result("only").status).toBe("not_evaluable");
    });

    it("a conflict on another requirement's claim does not block this one", async () => {
      const policySetId = await policy(singleRule({ blockingConflictTypes: ["rights_conflict"] }));
      const projectId = await newProject();
      await claim(projectId, "mining_right_registration");
      const other = await claim(projectId, "project_identity");
      await fx.sql`
        INSERT INTO core.claim_conflicts (id, tenant_id, claim_id, conflict_type)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${other}, 'rights_conflict')
      `;
      expect((await assess(projectId, policySetId)).result("only").status).toBe("ok");
    });
  });

  describe("REQ-DAPP-026 / AC-04: stale or expired evidence", () => {
    it("a stale claim makes its requirement a gap", async () => {
      const policySetId = await policy(singleRule({}));
      const projectId = await newProject();
      await claim(projectId, "mining_right_registration", {
        staleSince: new Date(Date.now() - 60_000).toISOString(),
      });
      const { body, result } = await assess(projectId, policySetId);
      expect(result("only").status).toBe("gap");
      expect(result("only").reasonCode).toBe("EVIDENCE_STALE");
      expect(result("only").missing).toEqual(["stale:mining_right_registration"]);
      expect(body.status).toBe("gap");
    });

    it("an expired or stale attestation no longer counts", async () => {
      const policySetId = await policy(singleRule({ requiredAttestations: ["professional_signoff"] }));

      for (const [label, state, validUntil, expected] of [
        ["current", "signed", null, "ok"],
        ["expired", "signed", new Date(Date.now() - 60_000).toISOString(), "gap"],
        ["stale", "stale_candidate", null, "gap"],
      ] as const) {
        const projectId = await newProject();
        const claimId = await claim(projectId, "mining_right_registration");
        await attestation(projectId, claimId, state, validUntil);
        const result = (await assess(projectId, policySetId)).result("only");
        expect(result.status, label).toBe(expected);
        if (expected === "gap") expect(result.reasonCode, label).toBe("MISSING_REQUIRED_ATTESTATION");
      }
    });

    it("an attestation over a different claim does not satisfy this requirement", async () => {
      const policySetId = await policy(singleRule({ requiredAttestations: ["professional_signoff"] }));
      const projectId = await newProject();
      await claim(projectId, "mining_right_registration");
      const other = await claim(projectId, "project_identity");
      await attestation(projectId, other, "signed", null);
      expect((await assess(projectId, policySetId)).result("only").reasonCode).toBe(
        "MISSING_REQUIRED_ATTESTATION",
      );
    });
  });

  async function attestation(
    projectId: string,
    claimId: string,
    state: string,
    validUntil: string | null,
  ): Promise<void> {
    const caseId = randomUUID();
    const assignmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_cases (id, tenant_id, project_id, schema_id, state)
      VALUES (${caseId}, ${fx.tenantA}, ${projectId}, ${fx.schemaA}, 'signed')
    `;
    await fx.sql`
      INSERT INTO core.assignments (id, tenant_id, case_id, subject_id, credential_id)
      VALUES (${assignmentId}, ${fx.tenantA}, ${caseId}, ${fx.reviewerSubjectA}, ${fx.credentialA})
    `;
    await fx.sql`
      INSERT INTO core.verification_attestations (
        id, tenant_id, case_id, assignment_id, credential_id, schema_id, attestation_type,
        claim_scope, evidence_snapshot_hash, limitations, credential_status_snapshot,
        method_version, policy_version, payload_hash, signature, signer_wallet_address,
        signed_at, valid_until, state
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${caseId}, ${assignmentId}, ${fx.credentialA}, ${fx.schemaA},
        'professional_signoff', ${[claimId]}, ${"0x" + "d4".repeat(32)},
        'Scope limited to registration status', ${fx.sql.json({ status: "valid" })},
        '1', '1', ${"0x" + "e5".repeat(32)}, ${"0x" + "f6".repeat(65)},
        ${fx.reviewerA.address}, now(), ${validUntil}, ${state}
      )
    `;
  }
});
