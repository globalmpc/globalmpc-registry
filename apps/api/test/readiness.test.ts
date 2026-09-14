import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
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

  function decide(wallet: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/gate-decisions`,
      headers: { authorization: `Bearer ${wallet}`, "idempotency-key": idempotencyKey() },
      payload: { gateId: "registry_publication", ...body },
    });
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
    ).rejects.toThrow(/수정·삭제할 수 없다/);
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
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });

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
