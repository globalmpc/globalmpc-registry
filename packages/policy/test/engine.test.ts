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

describe("happy path", () => {
  it("is ok when every requirement is satisfied", () => {
    const assessment = evaluateAssessment(ruleSet, allSatisfiedInput());
    expect(assessment.status).toBe("ok");
    expect(assessment.requirementResults.every((r) => r.status === "ok")).toBe(true);
  });

  it("excludes non-applicable requirements from aggregation", () => {
    // offeringIntent=false, so ersp-linkage does not apply.
    const assessment = evaluateAssessment(ruleSet, allSatisfiedInput());
    const ersp = assessment.requirementResults.find((r) => r.requirementId === "ersp-linkage")!;
    expect(ersp.applicable).toBe(false);
    expect(ersp.reasonCode).toBe("REQUIREMENT_NOT_APPLICABLE");
  });
});

describe("gap judgment", () => {
  it("is gap when a required claim type is missing and returns what is missing", () => {
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

  it("is gap when grade is below the minimum", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { grade: "self_reported" } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("GRADE_BELOW_MINIMUM");
  });

  it("is gap when there is no evidence at all", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { grade: null } }),
    );
    expect(assessment.status).toBe("gap");
  });

  it("is gap when a required attestation is missing and returns which type", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { presentAttestations: ["professional_signoff"] } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("MISSING_REQUIRED_ATTESTATION");
    expect(result.missing).toEqual(["legal_notarization"]);
  });

  it("exceeding freshness is gap", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { evidenceAgeDays: "181" } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("EVIDENCE_STALE");
  });

  it("the boundary value passes", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { evidenceAgeDays: "180" } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("ok");
  });

  it("is gap when a blocking conflict exists", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { unresolvedConflictTypes: ["rights_conflict"] } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("gap");
    expect(result.reasonCode).toBe("BLOCKING_CONFLICT");
  });

  it("a conflict not in the blocking list does not cause gap", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { unresolvedConflictTypes: ["unrelated_conflict"] } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("ok");
  });
});

describe("not_evaluable judgment — distinct from gap", () => {
  it("is not_evaluable when there is no evaluation basis", () => {
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

  it("is not_evaluable when facts are not supplied — never treated as a pass", () => {
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

  it("is not_evaluable when freshness is required but the age is unknown", () => {
    const assessment = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { evidenceAgeDays: null } }),
    );
    const result = assessment.requirementResults.find((r) => r.requirementId === "mining-right")!;
    expect(result.status).toBe("not_evaluable");
  });

  it("not_evaluable is judged before gap", () => {
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

describe("watch judgment", () => {
  it("is watch when the watch condition holds", () => {
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

  it("watch comes after gap — with no evidence it is gap, not watch", () => {
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

describe("AC-11 — evaluation determinism", () => {
  it("the same input yields the same canonical hash", () => {
    const input = allSatisfiedInput();
    const first = evaluateAssessment(ruleSet, input);
    const second = evaluateAssessment(ruleSet, input);
    expect(assessmentHash(first)).toBe(assessmentHash(second));
  });

  it("the hash is unchanged when requirement order changes", () => {
    const reversed: RuleSet = {
      ...ruleSet,
      requirements: [...ruleSet.requirements].reverse(),
    };
    const input = allSatisfiedInput();
    expect(assessmentHash(evaluateAssessment(reversed, input))).toBe(
      assessmentHash(evaluateAssessment(ruleSet, input)),
    );
  });

  it("a different input yields a different hash", () => {
    const base = evaluateAssessment(ruleSet, allSatisfiedInput());
    const changed = evaluateAssessment(
      ruleSet,
      allSatisfiedInput({ "mining-right": { grade: "self_reported" } }),
    );
    expect(assessmentHash(changed)).not.toBe(assessmentHash(base));
  });

  it("a different rule version yields a different hash", () => {
    const input = allSatisfiedInput();
    const bumped: RuleSet = { ...ruleSet, version: "1.0.1" };
    expect(assessmentHash(evaluateAssessment(bumped, input))).not.toBe(
      assessmentHash(evaluateAssessment(ruleSet, input)),
    );
  });

  it("does not depend on the current time — the same snapshot evaluates the same at any time", () => {
    const input = allSatisfiedInput();
    const hashes = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      hashes.add(assessmentHash(evaluateAssessment(ruleSet, input)));
    }
    expect(hashes.size).toBe(1);
  });
});

describe("policy engine combined with gate decision", () => {
  it("a gap blocks go (AC-02)", () => {
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
      rationale: "request to proceed",
    });
    expect(decision.allowed).toBe(false);
  });

  it("not_evaluable blocks go (AC-34)", () => {
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
      rationale: "request to proceed",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("GATE_NOT_EVALUABLE_BLOCKS_GO");
  });

  it("all ok allows go — but a person must request it (AC-03)", () => {
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
  it("the result status is always one of four values", () => {
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
