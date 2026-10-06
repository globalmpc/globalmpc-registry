import { describe, expect, it } from "vitest";
import { OFFERING_PRECONDITIONS, checkOfferingGate } from "../src/offering-gate.js";
import { atLifecycleMachine, type AtLifecycleState } from "../src/machines.js";
import { checkLifecycleGuard, type LifecycleGuardFacts } from "../src/lifecycle-guards.js";

/**
 * Lifecycle transition guards — spec 04 §4.3, invariant 7, AC-03.
 *
 * A reason string used to be enough to open an offering. These tests pin what must be true
 * instead, and that a condition this system cannot see refuses the move.
 */

const nothingRecorded: LifecycleGuardFacts = {
  offeringGate: checkOfferingGate([]),
  latestOfferingDecision: null,
  reviewedSinceSuspension: false,
};

const allConfirmed = checkOfferingGate(
  OFFERING_PRECONDITIONS.map((p) => ({ key: p.key, satisfied: true, evidenceRef: `doc://${p.key}` })),
);

function keys(result: ReturnType<typeof checkLifecycleGuard>): string[] {
  return result.allowed ? [] : result.conditions.map((c) => c.key);
}

describe("registered → offering_open", () => {
  it("lists every missing precondition and the missing go decision", () => {
    const result = checkLifecycleGuard("registered", "offering_open", nothingRecorded);

    expect(result.allowed).toBe(false);
    expect(keys(result)).toEqual([
      ...OFFERING_PRECONDITIONS.map((p) => p.key),
      "offering_gate_go_decision",
    ]);
    // Invariant 7 names legal issuance specifically.
    expect(keys(result)).toContain("legal_issuance_decision");
  });

  it("AC-03: every condition met is still not go", () => {
    const result = checkLifecycleGuard("registered", "offering_open", {
      ...nothingRecorded,
      offeringGate: allConfirmed,
    });

    expect(keys(result)).toEqual(["offering_gate_go_decision"]);
  });

  it("a go decision does not replace the preconditions", () => {
    const result = checkLifecycleGuard("registered", "offering_open", {
      ...nothingRecorded,
      latestOfferingDecision: "go",
    });

    expect(keys(result)).toContain("legal_issuance_decision");
    expect(keys(result)).not.toContain("offering_gate_go_decision");
  });

  it("a later hold overrides an earlier go", () => {
    const result = checkLifecycleGuard("registered", "offering_open", {
      ...nothingRecorded,
      offeringGate: allConfirmed,
      latestOfferingDecision: "hold",
    });

    expect(result.allowed).toBe(false);
    expect(result.allowed ? "" : result.conditions[0]!.why).toContain("hold");
  });

  it("refuses a precondition confirmed without evidence even when nothing is missing", () => {
    const result = checkLifecycleGuard("registered", "offering_open", {
      ...nothingRecorded,
      latestOfferingDecision: "go",
      offeringGate: checkOfferingGate(
        OFFERING_PRECONDITIONS.map((p) => ({ key: p.key, satisfied: true, evidenceRef: null })),
      ),
    });

    expect(keys(result)).toEqual(["offering_precondition_evidence"]);
    expect(result.allowed ? [] : result.unsupported).toHaveLength(OFFERING_PRECONDITIONS.length);
  });

  it("reports unsupported offering data only for offering-family targets", () => {
    const result = checkLifecycleGuard("suspended", "registered", nothingRecorded);

    expect(result.allowed).toBe(false);
    expect(result.allowed ? [] : result.unsupported).toEqual([]);
  });

  it("opens only when every precondition is evidenced and a person decided go", () => {
    const result = checkLifecycleGuard("registered", "offering_open", {
      ...nothingRecorded,
      offeringGate: allConfirmed,
      latestOfferingDecision: "go",
    });

    expect(result.allowed).toBe(true);
  });
});

describe("rows whose inputs this system does not record", () => {
  const fullyApproved: LifecycleGuardFacts = {
    offeringGate: allConfirmed,
    latestOfferingDecision: "go",
    reviewedSinceSuspension: true,
  };

  // Every forward move past offering_open, and closure/retirement.
  const unrecorded: [AtLifecycleState, AtLifecycleState][] = [
    ["offering_open", "offering_closed"],
    ["offering_closed", "active"],
    ["active", "branch_vote"],
    ["active", "closure"],
    ["branch_vote", "continuing"],
    ["branch_vote", "divested"],
    ["continuing", "active"],
    ["continuing", "branch_vote"],
    ["divested", "closure"],
    ["closure", "retired"],
  ];

  it.each(unrecorded)("%s → %s is refused as not evaluable", (from, to) => {
    // Even with the offering fully approved: the row's own condition is invisible here.
    const result = checkLifecycleGuard(from, to, fullyApproved);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.conditions.length).toBeGreaterThan(0);
    expect(result.conditions.every((c) => c.status === "not_evaluable")).toBe(true);
  });

  it("covers every non-suspension move the state machine allows", () => {
    // A new edge in the machine without a guard row would pass silently.
    const guarded = new Set(unrecorded.map(([from, to]) => `${from}→${to}`));
    const handledInCode = new Set(["draft→registered", "registered→offering_open"]);
    const edges = Object.entries(atLifecycleMachine.transitions).flatMap(([from, targets]) =>
      targets
        .filter((to) => to !== "suspended" && from !== "suspended")
        .map((to) => `${from}→${to}`),
    );

    expect(edges.filter((edge) => !guarded.has(edge) && !handledInCode.has(edge))).toEqual([]);
  });
});

describe("draft → registered", () => {
  it("goes only through Registry publication", () => {
    const result = checkLifecycleGuard("draft", "registered", nothingRecorded);

    expect(result.allowed).toBe(false);
    expect(result.allowed ? "" : result.code).toBe("LIFECYCLE_REGISTER_VIA_PUBLICATION");
  });
});

describe("suspension", () => {
  it("entering suspended is never blocked", () => {
    for (const from of ["registered", "offering_open", "active", "closure"] as const) {
      expect(checkLifecycleGuard(from, "suspended", nothingRecorded).allowed).toBe(true);
    }
  });

  it("reinstatement needs something recorded after the suspension", () => {
    const result = checkLifecycleGuard("suspended", "registered", nothingRecorded);
    expect(keys(result)).toEqual(["review_since_suspension"]);

    const reviewed = checkLifecycleGuard("suspended", "registered", {
      ...nothingRecorded,
      reviewedSinceSuspension: true,
    });
    expect(reviewed.allowed).toBe(true);
  });

  it("refuses reinstatement when the suspension moment is unknown", () => {
    const result = checkLifecycleGuard("suspended", "registered", {
      ...nothingRecorded,
      reviewedSinceSuspension: null,
    });
    expect(keys(result)).toEqual(["review_since_suspension"]);
  });

  it("reinstating into an offering state re-checks the offering conditions", () => {
    const result = checkLifecycleGuard("suspended", "offering_open", {
      ...nothingRecorded,
      reviewedSinceSuspension: true,
    });
    expect(keys(result)).toContain("legal_issuance_decision");
  });

  it("closing a suspended project is always possible", () => {
    expect(checkLifecycleGuard("suspended", "closure", nothingRecorded).allowed).toBe(true);
  });
});
