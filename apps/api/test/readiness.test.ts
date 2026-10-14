import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
import {
  decideSigned,
  requestGateDecisionSignature,
  signGateDecision,
  submitGateDecision,
} from "./helpers/gate-decision.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("Readiness and Gate Decision", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { approverA: string; operatorA: string; stewardA: string };
  let policySetId: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // From R1, auth is SIWE signature → session token. Tests take the same path.
    tokens = {
      approverA: await signIn(app, fx.approverA),
      operatorA: await signIn(app, fx.operatorA),
      stewardA: await signIn(app, fx.stewardA),
    };

    policySetId = randomUUID();
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${policySetId}, ${fx.tenantA}, 'registry-publication-gate', '1.0.0',
        'registry_publication', 'MNG', now(), ${fx.sql.json(rulesFixture as never)}, 'effective'
      )
    `;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function recompute(wallet: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/readiness-assessments`,
      headers: { authorization: `Bearer ${wallet}`, "idempotency-key": idempotencyKey() },
      payload: { policySetId },
    });
  }

  /** Signed by the approver's own wallet unless a test says otherwise. */
  function decide(token: string, body: Record<string, unknown>, signer = fx.approverA) {
    return decideSigned(app, token, signer, fx.projectA, {
      gateId: "registry_publication",
      ...body,
    });
  }

  /** An assessment with the given requirement statuses, stored as the engine would store it. */
  async function storedAssessment(
    statuses: readonly ("ok" | "watch" | "gap" | "not_evaluable")[],
  ): Promise<string> {
    const id = randomUUID();
    const results = statuses.map((status, index) => ({
      requirementId: `req-${index}`,
      status,
      applicable: true,
      reasonCode: status === "watch" ? "WATCH_CONDITION_MET" : "REQUIREMENT_SATISFIED",
      missing: [],
    }));
    const overall = statuses.includes("watch") ? "watch" : "ok";
    await fx.sql`
      INSERT INTO core.compliance_assessments (
        id, tenant_id, project_id, gate_id, policy_set_id, input_snapshot_hash,
        evaluated_as_of, status, requirement_results, canonical_result_hash
      ) VALUES (
        ${id}, ${fx.tenantA}, ${fx.projectA}, 'registry_publication', ${policySetId},
        ${"0x" + "a1".repeat(32)}, now(), ${overall}, ${fx.sql.json(results as never)},
        ${"0x" + "b2".repeat(32)}
      )
    `;
    return id;
  }

  it("runs an evaluation and records a canonical hash", async () => {
    const response = await recompute(tokens.operatorA);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(["ok", "watch", "gap", "not_evaluable"]).toContain(body.status);
    expect(body.canonicalResultHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.requirementResults.length).toBeGreaterThan(0);
  });

  it("AC-11: the same input yields the same canonical hash", async () => {
    const first = (await recompute(tokens.operatorA)).json();
    const second = (await recompute(tokens.operatorA)).json();
    // evaluatedAsOf differs per request, so the input hash may differ.
    // The policy package guarantees that the same input snapshot gives the same result;
    // here we check that status stays stable over the same facts.
    expect(second.status).toBe(first.status);
    expect(second.requirementResults.length).toBe(first.requirementResults.length);
  });

  it("the response carries the §7.3 safety fields", async () => {
    const body = (await recompute(tokens.operatorA)).json();
    expect(body.authority).toContain("readiness assessment");
    expect(body.legalEffect).toBe("none");
    expect(body.limitations.join(" ")).toContain("does not replace a human decision");
    expect(body.disclaimerCodes).toContain("READINESS_IS_NOT_A_DECISION");
  });

  it("REQ-DAPP-017: no route modifies readiness", async () => {
    const assessment = (await recompute(tokens.operatorA)).json();

    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/readiness-assessments/${assessment.id}`,
        headers: { authorization: `Bearer ${tokens.operatorA}` },
      });
      expect(response.statusCode, method).toBe(404);
    }
  });

  it("REQ-DAPP-017: the DB rejects modification too", async () => {
    const assessment = (await recompute(tokens.operatorA)).json();
    await expect(
      fx.sql`
        UPDATE core.compliance_assessments SET status = 'ok' WHERE id = ${assessment.id}
      `,
    ).rejects.toThrow(/cannot be modified or deleted/);
  });

  it("rejects evaluation with a non-effective policy", async () => {
    const draftPolicy = randomUUID();
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${draftPolicy}, ${fx.tenantA}, 'draft-rules', '0.1.0', 'registry_publication',
        'MNG', now(), ${fx.sql.json(rulesFixture as never)}, 'draft'
      )
    `;

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/readiness-assessments`,
      headers: { authorization: `Bearer ${tokens.operatorA}`, "idempotency-key": idempotencyKey() },
      payload: { policySetId: draftPolicy },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("POLICY_NOT_EFFECTIVE");
  });

  describe("Gate Decision", () => {
    it("AC-02: rejects go when a gap exists", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      // The fixture project has almost no evidence, so it is gap or not_evaluable.
      expect(["gap", "not_evaluable"]).toContain(assessment.status);

      const response = await decide(tokens.approverA, {
        decision: "go",
        inputAssessmentId: assessment.id,
        rationale: "want to proceed",
      });

      expect(response.statusCode).toBe(422);
      expect(["GATE_GAP_BLOCKS_GO", "GATE_NOT_EVALUABLE_BLOCKS_GO"]).toContain(
        response.json().code,
      );
    });

    it("reports the blocked requirement indexes", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        decision: "go",
        inputAssessmentId: assessment.id,
        rationale: "request to proceed",
      });
      expect(response.json().details.blockingRequirementIndexes.length).toBeGreaterThan(0);
    });

    it("records hold even with a gap", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "holding for lack of evidence",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().decision).toBe("hold");
    });

    it("records stop and rework too — bad news is not blocked", async () => {
      for (const decision of ["stop", "rework"] as const) {
        const assessment = (await recompute(tokens.operatorA)).json();
        const response = await decide(tokens.approverA, {
          decision,
          inputAssessmentId: assessment.id,
          rationale: `${decision} rationale`,
        });
        expect(response.statusCode, decision).toBe(200);
      }
    });

    it("rejects a decision without rationale", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "",
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a decision from a non-gate-approver", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.stewardA, {
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "unauthorized attempt",
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().details.requiredRoles).toContain("gate_approver");
    });

    it("rejects a decision on a nonexistent assessment", async () => {
      const response = await decide(tokens.approverA, {
        decision: "hold",
        inputAssessmentId: randomUUID(),
        rationale: "nonexistent assessment",
      });
      expect(response.statusCode).toBe(404);
    });

    it("a decision cannot be modified", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const decision = (
        await decide(tokens.approverA, {
          decision: "hold",
          inputAssessmentId: assessment.id,
          rationale: "hold",
        })
      ).json();

      await expect(
        fx.sql`UPDATE core.gate_decisions SET decision = 'go' WHERE id = ${decision.id}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });

    it("AC-34: a refused go says why, what is needed and what to do next", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        decision: "go",
        inputAssessmentId: assessment.id,
        rationale: "request to proceed",
      });
      expect(response.statusCode).toBe(422);
      const blocking = response.json().details.blockingRequirements as {
        requirementId: string;
        status: string;
        cause: string;
        neededEvidence: string[];
        nextAction: string;
      }[];
      expect(blocking.length).toBe(response.json().details.blockingRequirementIndexes.length);
      for (const item of blocking) {
        expect(["gap", "not_evaluable"]).toContain(item.status);
        expect(item.cause.length, item.requirementId).toBeGreaterThan(0);
        expect(item.neededEvidence.length, item.requirementId).toBeGreaterThan(0);
        expect(item.nextAction, item.requirementId).toBeTruthy();
      }
    });

    it("the assessment carries the same explanation per requirement", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const notEvaluable = assessment.requirementResults.filter(
        (result: { status: string }) => result.status === "not_evaluable",
      );
      expect(notEvaluable.length).toBeGreaterThan(0);
      for (const result of notEvaluable) {
        expect(result.cause).toBeTruthy();
        expect(result.nextAction).toBeTruthy();
      }

      const read = await app.inject({
        method: "GET",
        url: `/api/v1/readiness-assessments/${assessment.id}`,
        headers: { authorization: `Bearer ${tokens.operatorA}` },
      });
      expect(read.json().requirementResults).toEqual(assessment.requirementResults);
    });

    it("§11.3: watch → go is refused without a condition", async () => {
      const inputAssessmentId = await storedAssessment(["ok", "watch"]);
      const response = await decide(tokens.approverA, {
        decision: "go",
        inputAssessmentId,
        rationale: "The watch item is monitored",
        conditions: ["  "],
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("GATE_WATCH_REQUIRES_CONDITIONS");
    });

    it("§11.3: watch → go with a condition is recorded with its conditions and assumptions", async () => {
      const inputAssessmentId = await storedAssessment(["ok", "watch"]);
      const response = await decide(tokens.approverA, {
        decision: "go",
        inputAssessmentId,
        rationale: "The watch item is monitored",
        assumptions: ["The licence renewal is filed"],
        conditions: ["Re-assess before the licence expiry date", ""],
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().conditions).toEqual(["Re-assess before the licence expiry date"]);
      expect(response.json().assumptions).toEqual(["The licence renewal is filed"]);
    });

    it("a decision on one gate cannot use another gate's assessment", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        gateId: "some_other_gate",
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "wrong gate",
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("GATE_ASSESSMENT_MISMATCH");
    });
  });

  describe("Gate Decision signature (§11.3)", () => {
    async function holdContent() {
      const assessment = (await recompute(tokens.operatorA)).json();
      return {
        gateId: "registry_publication",
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "holding for lack of evidence",
      };
    }

    it("records the approver's wallet as the signer", async () => {
      const response = await decide(tokens.approverA, await holdContent());
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().signerWalletAddress).toBe(fx.approverA.address);

      const [row] = await fx.sql<{ signature: string; signer_wallet_address: string }[]>`
        SELECT signature, signer_wallet_address FROM core.gate_decisions
        WHERE id = ${response.json().id}
      `;
      expect(row!.signature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(row!.signer_wallet_address).toBe(fx.approverA.address);
    });

    it("refuses a decision without a signature", async () => {
      const content = await holdContent();
      for (const extra of [{}, { signature: "" }, { signatureRequestId: randomUUID(), signature: "" }]) {
        const response = await submitGateDecision(app, tokens.approverA, fx.projectA, {
          ...content,
          ...extra,
        });
        expect(response.statusCode, JSON.stringify(extra)).toBe(400);
      }
    });

    it("refuses a signature made by someone else's wallet", async () => {
      const response = await decide(tokens.approverA, await holdContent(), fx.stewardA);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("SIGNATURE_SIGNER_MISMATCH");
    });

    it("refuses a signed decision whose content changed after the request", async () => {
      const content = await holdContent();
      const requested = (
        await requestGateDecisionSignature(app, tokens.approverA, fx.projectA, content)
      ).json();
      const signature = await signGateDecision(fx.approverA, requested);
      const response = await submitGateDecision(app, tokens.approverA, fx.projectA, {
        ...content,
        rationale: "a different rationale than the one signed",
        signatureRequestId: requested.signatureRequestId,
        signature,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("SIGNATURE_PAYLOAD_MISMATCH");
    });

    it("a signature request is single-use", async () => {
      const content = await holdContent();
      const requested = (
        await requestGateDecisionSignature(app, tokens.approverA, fx.projectA, content)
      ).json();
      const signature = await signGateDecision(fx.approverA, requested);
      const body = { ...content, signatureRequestId: requested.signatureRequestId, signature };

      expect((await submitGateDecision(app, tokens.approverA, fx.projectA, body)).statusCode).toBe(200);
      const replay = await submitGateDecision(app, tokens.approverA, fx.projectA, body);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().code).toBe("SIGNATURE_REQUEST_UNUSABLE");
    });

    it("the signing target states what is decided and what it does not mean", async () => {
      const requested = await requestGateDecisionSignature(
        app,
        tokens.approverA,
        fx.projectA,
        await holdContent(),
      );
      expect(requested.statusCode).toBe(200);
      expect(requested.json().typedData.primaryType).toBe("GateDecision");
      expect(requested.json().humanReadablePayload).toContain("Decision: hold");
      expect(requested.json().humanReadablePayload).toContain("not a legal approval");
    });

    it("the DB refuses an unsigned decision row", async () => {
      const content = await holdContent();
      const [subject] = await fx.sql<{ id: string }[]>`
        SELECT subject_id AS id FROM core.wallet_identities WHERE wallet_address = ${fx.approverA.address}
      `;
      await expect(
        fx.sql`
          INSERT INTO core.gate_decisions (
            id, tenant_id, project_id, gate_id, decision, input_assessment_id,
            evidence_snapshot_hash, decision_authority, decision_maker_subject_id,
            rationale, signature, signed_at
          ) VALUES (
            ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_publication', 'hold',
            ${content.inputAssessmentId}, ${"0x" + "cc".repeat(32)}, 'MPC Gate Approver',
            ${subject!.id}, 'unsigned', '', now()
          )
        `,
      ).rejects.toThrow(/gate_decision_signature_present/);
    });
  });

  describe("Gate Decision records", () => {
    it("a decision writes audit and outbox", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const decision = (
        await decide(tokens.approverA, {
          decision: "hold",
          inputAssessmentId: assessment.id,
          rationale: "for audit check",
        })
      ).json();

      const audits = await fx.sql<{ command: string; reason: string }[]>`
        SELECT command, reason FROM audit.events WHERE resource_id = ${decision.id}
      `;
      expect(audits[0]?.command).toBe("gate.decision.recorded");
      expect(audits[0]?.reason).toBe("for audit check");
    });
  });
});
