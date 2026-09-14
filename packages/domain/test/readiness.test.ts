import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  READINESS_STATUSES,
  aggregateReadiness,
  checkGateDecision,
  isGoBlocking,
  type ReadinessStatus,
} from "../src/readiness.js";

describe("AC-02 — 필수 gap은 go를 차단한다", () => {
  it("gap이 하나라도 있으면 go가 거절된다", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "ok", "gap"],
      hasAssessment: true,
      rationale: "진행하고 싶다",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("GATE_GAP_BLOCKS_GO");
      expect(result.blockingRequirementIndexes).toEqual([2]);
    }
  });

  it("차단된 requirement의 인덱스를 전부 반환한다", () => {
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

describe("AC-34 — not_evaluable도 go를 차단한다", () => {
  it("gap이 모두 해소돼도 not_evaluable이 남으면 거절된다", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "ok", "not_evaluable"],
      hasAssessment: true,
      rationale: "gap은 전부 해소했다",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("GATE_NOT_EVALUABLE_BLOCKS_GO");
    }
  });

  it("not_evaluable과 gap이 함께 있으면 not_evaluable을 먼저 보고한다", () => {
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

  it("두 상태 모두 go-blocking이다", () => {
    expect(isGoBlocking("gap")).toBe(true);
    expect(isGoBlocking("not_evaluable")).toBe(true);
    expect(isGoBlocking("watch")).toBe(false);
    expect(isGoBlocking("ok")).toBe(false);
  });
});

describe("AC-03 — all ok가 자동 go는 아니다", () => {
  it("모두 ok여도 GateDecision 요청 자체는 필요하다", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "ok", "ok"],
      hasAssessment: true,
      rationale: null,
    });
    // 허용될 뿐 자동으로 발생하지 않는다. 사람이 요청해야 이 함수가 호출된다.
    expect(result.allowed).toBe(true);
  });

  it("assessment가 없으면 어떤 결정도 기록할 수 없다", () => {
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

describe("watch → go 승격", () => {
  it("사유 없이 승격할 수 없다", () => {
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

  it("공백만 있는 사유도 거절한다", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["watch"],
      hasAssessment: true,
      rationale: "   ",
    });
    expect(result.allowed).toBe(false);
  });

  it("사유가 있으면 허용한다", () => {
    const result = checkGateDecision({
      decision: "go",
      requirementStatuses: ["ok", "watch"],
      hasAssessment: true,
      rationale: "환경 baseline은 분기 재확인 조건으로 monitoring한다",
    });
    expect(result.allowed).toBe(true);
  });
});

describe("go 이외의 결정", () => {
  for (const decision of ["hold", "rework", "stop"] as const) {
    it(`${decision}은 gap·not_evaluable이 있어도 기록할 수 있다`, () => {
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
  it("최악값을 고른다", () => {
    expect(aggregateReadiness(["ok", "watch", "gap"])).toBe("gap");
    expect(aggregateReadiness(["ok", "watch"])).toBe("watch");
    expect(aggregateReadiness(["ok", "ok"])).toBe("ok");
  });

  it("not_evaluable이 gap보다 나쁘다 — 무엇을 채워야 할지도 모르는 상태다", () => {
    expect(aggregateReadiness(["gap", "not_evaluable"])).toBe("not_evaluable");
  });

  it("빈 집합은 not_evaluable이다", () => {
    expect(aggregateReadiness([])).toBe("not_evaluable");
  });

  it("입력 순서와 무관하다", () => {
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

  it("go-blocking 상태가 하나라도 있으면 집계 결과도 go-blocking이다", () => {
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

describe("property — gate 결정", () => {
  it("go는 blocking 상태가 없을 때만 허용된다", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<ReadinessStatus>(...READINESS_STATUSES), { maxLength: 8 }),
        (statuses) => {
          const result = checkGateDecision({
            decision: "go",
            requirementStatuses: statuses,
            hasAssessment: true,
            rationale: "사유",
          });
          expect(result.allowed).toBe(!statuses.some(isGoBlocking));
        },
      ),
      { numRuns: 400 },
    );
  });
});
