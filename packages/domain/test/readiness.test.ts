import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  READINESS_STATUSES,
  aggregateReadiness,
  checkGateDecision,
  isGoBlocking,
  type ReadinessStatus,
} from "../src/readiness.js";

describe("AC-02 — a required gap blocks go", () => {
  it("go is rejected if any gap exists", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "ok", "gap"],
      hasAssessment: true,
      rationale: "We want to proceed",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("GATE_GAP_BLOCKS_GO");
      expect(result.blockingRequirementIndexes).toEqual([2]);
    }
  });

  it("returns every index of the blocked requirements", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["gap", "ok", "gap", "watch"],
      hasAssessment: true,
      rationale: null,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.blockingRequirementIndexes).toEqual([0, 2]);
    }
  });
});

describe("AC-34 — not_evaluable also blocks go", () => {
  it("rejected while not_evaluable remains even after every gap is resolved", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "ok", "not_evaluable"],
      hasAssessment: true,
      rationale: "All gaps are resolved",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("GATE_NOT_EVALUABLE_BLOCKS_GO");
    }
  });

  it("reports not_evaluable first when present together with gap", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["gap", "not_evaluable"],
      hasAssessment: true,
      rationale: null,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("GATE_NOT_EVALUABLE_BLOCKS_GO");
    }
  });

  it("both states are go-blocking", () => {
    expect(isGoBlocking("gap")).toBe(true);
    expect(isGoBlocking("not_evaluable")).toBe(true);
    expect(isGoBlocking("watch")).toBe(false);
    expect(isGoBlocking("ok")).toBe(false);
  });
});

describe("AC-03 — all ok is not an automatic go", () => {
  it("a GateDecision request is still required even when all are ok", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "ok", "ok"],
      hasAssessment: true,
      rationale: null,
    });
    // It is only allowed, never automatic. This function is called only when a person requests it.
    expect(result.allowed).toBe(true);
  });

  it("no decision can be recorded without an assessment", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: [],
      hasAssessment: false,
      rationale: null,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("GATE_MISSING_ASSESSMENT");
    }
  });
});

describe("watch → go promotion", () => {
  it("cannot promote without a rationale", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "watch"],
      hasAssessment: true,
      rationale: null,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("GATE_WATCH_REQUIRES_RATIONALE");
    }
  });

  it("rejects a whitespace-only rationale too", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["watch"],
      hasAssessment: true,
      rationale: "   ",
    });
    expect(result.allowed).toBe(false);
  });

  it("allows when a rationale is given", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "watch"],
      hasAssessment: true,
      rationale: "The environmental baseline is monitored under a quarterly re-check condition",
    });
    expect(result.allowed).toBe(true);
  });
});

describe("decisions other than go", () => {
  for (const decision of ["hold", "rework", "stop"] as const) {
    it(`${decision} can be recorded even with gap or not_evaluable`, () => {
      const result = checkGateDecision({
        decision,
        requirementStatuses: ["gap", "not_evaluable"],
        hasAssessment: true,
        rationale: null,
      });
      expect(result.allowed).toBe(true);
    });
  }
});

describe("aggregateReadiness", () => {
  it("picks the worst value", () => {
    expect(aggregateReadiness(["ok", "watch", "gap"])).toBe("gap");
    expect(aggregateReadiness(["ok", "watch"])).toBe("watch");
    expect(aggregateReadiness(["ok", "ok"])).toBe("ok");
  });

  it("not_evaluable is worse than gap — it does not even know what to fill in", () => {
    expect(aggregateReadiness(["gap", "not_evaluable"])).toBe("not_evaluable");
  });

  it("an empty set is not_evaluable", () => {
    expect(aggregateReadiness([])).toBe("not_evaluable");
  });

  it("is independent of input order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ReadinessStatus>(...READINESS_STATUSES), { maxLength: 10 }),
        (statuses) => {
          expect(aggregateReadiness([...statuses].reverse())).toBe(aggregateReadiness(statuses));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the aggregate is go-blocking if any go-blocking state exists", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ReadinessStatus>(...READINESS_STATUSES), {
          minLength: 1,
          maxLength: 10,
        }),
        (statuses) => {
          const hasBlocking = statuses.some(isGoBlocking);
          expect(isGoBlocking(aggregateReadiness(statuses))).toBe(hasBlocking);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("property — gate decision", () => {
  it("go is allowed only when no blocking state exists", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ReadinessStatus>(...READINESS_STATUSES), { maxLength: 8 }),
        (statuses) => {
          const result = checkGateDecision({
            decision: "go",
            requirementStatuses: statuses,
            hasAssessment: true,
            rationale: "rationale",
          });
          expect(result.allowed).toBe(!statuses.some(isGoBlocking));
        },
      ),
      { numRuns: 400 },
    );
  });
});
