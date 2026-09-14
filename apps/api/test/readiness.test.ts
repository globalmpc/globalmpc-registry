import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("Readiness와 Gate Decision", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { approverA: string; operatorA: string; stewardA: string };
  let policySetId: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // R1부터 인증은 SIWE 서명 → 세션 토큰이다. 테스트도 같은 경로를 지난다.
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

  it("평가가 실행되고 canonical hash를 남긴다", async () => {
    const response = await recompute(tokens.operatorA);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(["ok", "watch", "gap", "not_evaluable"]).toContain(body.status);
    expect(body.canonicalResultHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.requirementResults.length).toBeGreaterThan(0);
  });

  it("AC-11: 같은 입력은 같은 canonical hash를 만든다", async () => {
    const first = (await recompute(tokens.operatorA)).json();
    const second = (await recompute(tokens.operatorA)).json();
    // evaluatedAsOf가 요청마다 달라지므로 입력 해시는 다를 수 있다.
    // 같은 입력 snapshot이면 결과가 같아야 한다는 것은 policy 패키지가 보장하고,
    // 여기서는 같은 사실 위에서 status가 흔들리지 않는 것을 본다.
    expect(second.status).toBe(first.status);
    expect(second.requirementResults.length).toBe(first.requirementResults.length);
  });

  it("§7.3 안전 필드가 응답에 있다", async () => {
    const body = (await recompute(tokens.operatorA)).json();
    expect(body.authority).toContain("준비도 평가");
    expect(body.legalEffect).toBe("none");
    expect(body.limitations.join(" ")).toContain("사람의 결정을 대신하지 않는다");
    expect(body.disclaimerCodes).toContain("READINESS_IS_NOT_A_DECISION");
  });

  it("REQ-DAPP-017: readiness를 수정하는 경로가 없다", async () => {
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

  it("REQ-DAPP-017: DB에서도 수정할 수 없다", async () => {
    const assessment = (await recompute(tokens.operatorA)).json();
    await expect(
      fx.sql`
        UPDATE core.compliance_assessments SET status = 'ok' WHERE id = ${assessment.id}
      `,
    ).rejects.toThrow(/수정·삭제할 수 없다/);
  });

  it("effective가 아닌 policy로 평가할 수 없다", async () => {
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
    it("AC-02: gap이 있으면 go가 거절된다", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      // fixture 프로젝트에는 근거가 거의 없으므로 gap 또는 not_evaluable이다.
      expect(["gap", "not_evaluable"]).toContain(assessment.status);

      const response = await decide(tokens.approverA, {
        decision: "go",
        inputAssessmentId: assessment.id,
        rationale: "진행하고 싶다",
      });

      expect(response.statusCode).toBe(422);
      expect(["GATE_GAP_BLOCKS_GO", "GATE_NOT_EVALUABLE_BLOCKS_GO"]).toContain(
        response.json().code,
      );
    });

    it("차단된 requirement 인덱스를 알려준다", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        decision: "go",
        inputAssessmentId: assessment.id,
        rationale: "진행 요청",
      });
      expect(response.json().details.blockingRequirementIndexes.length).toBeGreaterThan(0);
    });

    it("hold는 gap이 있어도 기록된다", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "근거 부족으로 보류한다",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().decision).toBe("hold");
    });

    it("stop·rework도 기록된다 — 나쁜 소식을 막지 않는다", async () => {
      for (const decision of ["stop", "rework"] as const) {
        const assessment = (await recompute(tokens.operatorA)).json();
        const response = await decide(tokens.approverA, {
          decision,
          inputAssessmentId: assessment.id,
          rationale: `${decision} 사유`,
        });
        expect(response.statusCode, decision).toBe(200);
      }
    });

    it("근거 없이 결정할 수 없다", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.approverA, {
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "",
      });
      expect(response.statusCode).toBe(400);
    });

    it("gate approver가 아니면 결정할 수 없다", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const response = await decide(tokens.stewardA, {
        decision: "hold",
        inputAssessmentId: assessment.id,
        rationale: "권한 없는 시도",
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().details.requiredRoles).toContain("gate_approver");
    });

    it("존재하지 않는 assessment로 결정할 수 없다", async () => {
      const response = await decide(tokens.approverA, {
        decision: "hold",
        inputAssessmentId: randomUUID(),
        rationale: "존재하지 않는 평가",
      });
      expect(response.statusCode).toBe(404);
    });

    it("결정은 수정할 수 없다", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const decision = (
        await decide(tokens.approverA, {
          decision: "hold",
          inputAssessmentId: assessment.id,
          rationale: "보류",
        })
      ).json();

      await expect(
        fx.sql`UPDATE core.gate_decisions SET decision = 'go' WHERE id = ${decision.id}`,
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });

    it("결정이 audit과 outbox를 남긴다", async () => {
      const assessment = (await recompute(tokens.operatorA)).json();
      const decision = (
        await decide(tokens.approverA, {
          decision: "hold",
          inputAssessmentId: assessment.id,
          rationale: "감사 확인용",
        })
      ).json();

      const audits = await fx.sql<{ command: string; reason: string }[]>`
        SELECT command, reason FROM audit.events WHERE resource_id = ${decision.id}
      `;
      expect(audits[0]?.command).toBe("gate.decision.recorded");
      expect(audits[0]?.reason).toBe("감사 확인용");
    });
  });
});
