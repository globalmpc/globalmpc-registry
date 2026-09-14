import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { checkGateDecision } from "@mpc/domain";
import { assessmentHash, evaluateAssessment, type AssessmentInput, type RequirementFacts } from "../src/engine.js";
import { parseRuleSet, type RuleSet } from "../src/rule-schema.js";
import rulesFixture from "./fixtures/registry-gate.rules.json" with { type: "json" };

const ruleSet: RuleSet = parseRuleSet(rulesFixture);

const SATISFIED: RequirementFacts = {
  presentClaimTypes: [],
  grade: "verified",
  presentAttestations: ["professional_signoff", "legal_notarization", "laboratory_accreditation"],
  evidenceAgeDays: "30",
  unresolvedConflictTypes: [],
  context: {
    projectStage: "exploration_or_later",
    acceptedReportingStandard: "JORC-2012",
    environmentalRequirementBasis: "MNG-EIA-2019",
    jurisdictionProfileState: "approved",
    offeringIntent: "false",
    rightsExpiryWithin12Months: "false",
    openFindingCount: "0",
  },
};

function factsFor(requirementId: string, overrides: Partial<RequirementFacts> = {}): RequirementFacts {
  const requirement = ruleSet.requirements.find((item) => item.requirementId === requirementId)!;
  return {
    ...SATISFIED,
    presentClaimTypes: requirement.requiredClaimTypes,
    ...overrides,
  };
}

function allSatisfiedInput(overrides: Record<string, Partial<RequirementFacts>> = {}): AssessmentInput {
  const requirementFacts: Record<string, RequirementFacts> = {};
  for (const requirement of ruleSet.requirements) {
    requirementFacts[requirement.requirementId] = factsFor(
      requirement.requirementId,
      overrides[requirement.requirementId] ?? {},
    );
  }
  return {
    subjectId: "SYNTH-PROJECT-001",
    gateId: "registry_publication",
    inputSnapshotHash: "0x" + "11".repeat(32),
    evaluatedAsOf: "2026-08-01T00:00:00Z",
    requirementFacts,
  };
}

describe("정상 경로", () => {
  it("모든 요구가 충족되면 ok다", () => {
    const assessment = evaluateAssessment(ruleSet, allSatisfiedInput());
    expect(assessment.status).toBe("ok");
    expect(assessment.requirementResults.every((r) => r.status === "ok")).toBe(true);
  });

  it("적용되지 않는 requirement는 집계에서 제외된다", () => {
    // offeringIntent=false이므로 ersp-linkage는 적용되지 않는다.
    const assessment = evaluateAssessment(ruleSet, allSatisfiedInput());
    const ersp = assessment.requirementResults.find((r) => r.requirementId === "ersp-linkage")!;
    expect(ersp.applicable).toBe(false);
    expect(ersp.reasonCode).toBe("REQUIREMENT_NOT_APPLICABLE");
  });
});

describe("gap 판정", () => {
  it("필수 claim type이 없으면 gap이고 무엇이 없는지 반환한다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { presentClaimTypes: [] } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("MISSING_REQUIRED_CLAIM_TYPE");
    expect(result.missing).toEqual(["mining_right_registration"]);
    expect(assessment.status).toBe("gap");
  });

  it("grade가 최소치 미만이면 gap이다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { grade: "self_reported" } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("GRADE_BELOW_MINIMUM");
  });

  it("근거가 아예 없으면 gap이다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { grade: null } }),
    );
    expect(assessment.status).toBe("gap");
  });

  it("필수 attestation이 없으면 gap이고 어떤 유형인지 반환한다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { presentAttestations: ["professional_signoff"] } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("MISSING_REQUIRED_ATTESTATION");
    expect(result.missing).toEqual(["legal_notarization"]);
  });

  it("freshness 초과는 gap이다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { evidenceAgeDays: "181" } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("EVIDENCE_STALE");
  });

  it("경계값은 통과한다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { evidenceAgeDays: "180" } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("ok");
  });

  it("blocking conflict가 있으면 gap이다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { unresolvedConflictTypes: ["rights_conflict"] } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("BLOCKING_CONFLICT");
  });

  it("blocking 목록에 없는 conflict는 gap을 만들지 않는다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { unresolvedConflictTypes: ["unrelated_conflict"] } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("ok");
  });
});

describe("not_evaluable 판정 — gap과 다르다", () => {
  it("판단 기준이 없으면 not_evaluable이다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({
        "resource-estimate": {
          context: { ...SATISFIED.context, acceptedReportingStandard: undefined },
        },
      }),
    );
    const result = assessment.requirementResults.find(
      (r) => r.requirementId === "resource-estimate",
    )!;
    expect(result.status).toBe("not_evaluable");
    expect(result.reasonCode).toBe("NO_EVALUATION_BASIS");
  });

  it("사실이 공급되지 않으면 not_evaluable이다 — 통과로 처리하지 않는다", () => {
    const input = allSatisfiedInput();
    const withoutFacts: AssessmentInput = {
      ...input,
      requirementFacts: Object.fromEntries(
        Object.entries(input.requirementFacts).filter(([key]) => key !== "project-identity"),
      ),
    };
    const assessment = evaluateAssessment(ruleSet, withoutFacts);
    const result = assessment.requirementResults.find(
      (r) => r.requirementId === "project-identity",
    )!;
    expect(result.status).toBe("not_evaluable");
    expect(result.reasonCode).toBe("FACTS_NOT_SUPPLIED");
  });

  it("freshness를 요구하는데 경과일을 모르면 not_evaluable이다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { evidenceAgeDays: null } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("not_evaluable");
  });

  it("not_evaluable은 gap보다 먼저 판정된다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({
        "mining-right": {
          presentClaimTypes: [],
          context: { ...SATISFIED.context, jurisdictionProfileState: "suspended" },
        },
      }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("not_evaluable");
  });
});

describe("watch 판정", () => {
  it("watch 조건이 맞으면 watch다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({
        "mining-right": {
          context: { ...SATISFIED.context, rightsExpiryWithin12Months: "true" },
        },
      }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("watch");
    expect(assessment.status).toBe("watch");
  });

  it("watch는 gap보다 나중이다 — 근거가 없으면 watch가 아니라 gap이다", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({
        "mining-right": {
          presentClaimTypes: [],
          context: { ...SATISFIED.context, rightsExpiryWithin12Months: "true" },
        },
      }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
  });
});

describe("AC-11 — 평가 결정성", () => {
  it("같은 입력은 같은 canonical hash를 만든다", () => {
    const input = allSatisfiedInput();
    const first = evaluateAssessment(ruleSet, input);
    const second = evaluateAssessment(ruleSet, input);
    expect(assessmentHash(first)).toBe(assessmentHash(second));
  });

  it("requirement 정의 순서가 바뀌어도 같은 hash다", () => {
    const reversed: RuleSet = {
      ...ruleSet,
      requirements: [...ruleSet.requirements].reverse(),
    };
    const input = allSatisfiedInput();
    expect(assessmentHash(evaluateAssessment(reversed, input))).toBe(
      assessmentHash(evaluateAssessment(ruleSet, input)),
    );
  });

  it("입력이 달라지면 hash가 달라진다", () => {
    const base = evaluateAssessment(ruleSet, allSatisfiedInput());
    const changed = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { grade: "self_reported" } }),
    );
    expect(assessmentHash(changed)).not.toBe(assessmentHash(base));
  });

  it("rule version이 달라지면 hash가 달라진다", () => {
    const input = allSatisfiedInput();
    const bumped: RuleSet = { ...ruleSet, version: "1.0.1" };
    expect(assessmentHash(evaluateAssessment(bumped, input))).not.toBe(
      assessmentHash(evaluateAssessment(ruleSet, input)),
    );
  });

  it("현재 시각에 의존하지 않는다 — 같은 snapshot이면 언제 평가해도 같다", () => {
    const input = allSatisfiedInput();
    const hashes = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      hashes.add(assessmentHash(evaluateAssessment(ruleSet, input)));
    }
    expect(hashes.size).toBe(1);
  });
});

describe("정책 엔진과 gate decision의 결합", () => {
  it("gap이 있으면 go가 차단된다 (AC-02)", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { presentClaimTypes: [] } }),
    );
    const decision = checkGateDecision({
      decision: "go",
      requirementStatuses: assessment.requirementResults
        .filter((r) => r.applicable)
        .map((r) => r.status),
      hasAssessment: true,
      rationale: "진행 요청",
    });
    expect(decision.allowed).toBe(false);
  });

  it("not_evaluable이 있으면 go가 차단된다 (AC-34)", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({
        "resource-estimate": {
          context: { ...SATISFIED.context, acceptedReportingStandard: undefined },
        },
      }),
    );
    const decision = checkGateDecision({
      decision: "go",
      requirementStatuses: assessment.requirementResults
        .filter((r) => r.applicable)
        .map((r) => r.status),
      hasAssessment: true,
      rationale: "진행 요청",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("GATE_NOT_EVALUABLE_BLOCKS_GO");
  });

  it("모두 ok면 go가 허용된다 — 다만 사람이 요청해야 한다 (AC-03)", () => {
    const assessment = evaluateAssessment(ruleSet, allSatisfiedInput());
    const decision = checkGateDecision({
      decision: "go",
      requirementStatuses: assessment.requirementResults
        .filter((r) => r.applicable)
        .map((r) => r.status),
      hasAssessment: true,
      rationale: null,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("property — assessment", () => {
  it("결과 status는 항상 4개 중 하나다", () => {
    fc.assert(
      fc.property(
        fc.record({
          grade: fc.constantFrom("verified", "partially_verified", "self_reported", "unverified", "rejected" as const),
          age: fc.integer({ min: 0, max: 5000 }).map(String),
          conflicts: fc.uniqueArray(fc.constantFrom("rights_conflict", "estimate_conflict", "other"), {
            maxLength: 3,
          }),
        }),
        ({ grade, age, conflicts }) => {
          const assessment = evaluateAssessment(
            ruleSet,
            allSatisfiedInput({
              "mining-right": {
                grade: grade as never,
                evidenceAgeDays: age,
                unresolvedConflictTypes: conflicts,
              },
            }),
          );
          expect(["ok", "watch", "gap", "not_evaluable"]).toContain(assessment.status);
        },
      ),
      { numRuns: 200 },
    );
  });
});
