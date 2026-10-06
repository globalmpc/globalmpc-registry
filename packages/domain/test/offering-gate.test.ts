import { describe, expect, it } from "vitest";
import {
  OFFERING_PRECONDITIONS,
  checkOfferingGate,
  type OfferingPreconditionKey,
  type PreconditionStatus,
} from "../src/offering-gate.js";

/**
 * Asset/Offering activation gate — OD-07.
 *
 * What this file guards is the fact that **no trading functionality exists**. Passing the gate
 * creates no trading path in code — deciding conditions and implementing are separate.
 */

const satisfied = (evidenceRef = "ref"): Omit<PreconditionStatus, "key"> => ({
  satisfied: true,
  evidenceRef,
});

function allSatisfied(): PreconditionStatus[] {
  return OFFERING_PRECONDITIONS.map((precondition) => ({
    key: precondition.key,
    ...satisfied(`doc://${precondition.key}`),
  }));
}

describe("activation conditions", () => {
  it("every condition remains when nothing is confirmed", () => {
    const decision = checkOfferingGate([]);
    expect(decision.activatable).toBe(false);
    if (!decision.activatable) {
      expect(decision.missing).toHaveLength(OFFERING_PRECONDITIONS.length);
    }
  });

  it("tells the owner and reason for each remaining condition", () => {
    const decision = checkOfferingGate([]);
    if (!decision.activatable) {
      // So the UI can show what remains instead of a blank screen or a disabled button.
      for (const item of decision.missing) {
        expect(item.why.length).toBeGreaterThan(0);
        expect(item.owner.length).toBeGreaterThan(0);
      }
    }
  });

  it("partial fulfillment does not activate", () => {
    // "Remittance first" is, from a regulatory standpoint, the same as opening everything.
    const partial = allSatisfied().slice(0, 3);
    expect(checkOfferingGate(partial).activatable).toBe(false);
  });

  it("catches items marked met without evidence separately", () => {
    // More dangerous than a missing item — it makes people believe it was confirmed.
    const statuses = allSatisfied().map((status, index) =>
      index === 0 ? { ...status, evidenceRef: null } : status,
    );

    const decision = checkOfferingGate(statuses);
    expect(decision.activatable).toBe(false);
    if (!decision.activatable) {
      expect(decision.unsupported).toContain(OFFERING_PRECONDITIONS[0]!.key);
    }
  });

  it("decides activatable when every condition is met with evidence", () => {
    expect(checkOfferingGate(allSatisfied()).activatable).toBe(true);
  });

  it("the legal issuance decision is a separate condition", () => {
    // Data readiness or a governance pass does not substitute for issuance approval.
    const keys = OFFERING_PRECONDITIONS.map((precondition) => precondition.key);
    expect(keys).toContain("legal_issuance_decision");
    expect(keys).toContain("security_audit");
  });
});

function allSatisfiedExcept(key: OfferingPreconditionKey): PreconditionStatus[] {
  return allSatisfied().filter((status) => status.key !== key);
}

describe("AC-07 — whitelist isolation", () => {
  it("AC-07: marketing access-list membership does not stand in for ERSP approval", () => {
    // Everything but the ERSP is evidenced, and the project also records that the wallet is on
    // the marketing access list. The list is not a precondition, so it cannot fill the gap.
    const statuses: PreconditionStatus[] = [
      ...allSatisfiedExcept("ersp_engaged"),
      {
        // The route passes `project_facts.fact_key` through the same way (authorities.ts).
        key: "marketing_access_list" as never,
        satisfied: true,
        evidenceRef: "doc://access-list",
      },
    ];

    const decision = checkOfferingGate(statuses);
    expect(decision.activatable).toBe(false);
    if (!decision.activatable) {
      expect(decision.missing.map((item) => item.key)).toEqual(["ersp_engaged"]);
    }
  });

  it("AC-07: no activation condition is an access-list or whitelist membership", () => {
    const keys: readonly string[] = OFFERING_PRECONDITIONS.map((precondition) => precondition.key);
    expect(keys.filter((key) => /access|whitelist|allowlist|marketing/.test(key))).toEqual([]);
  });
});

describe("AC-33 — ERSP status is not legal effect", () => {
  it("AC-33: ERSP confirmation alone activates nothing", () => {
    const decision = checkOfferingGate([
      { key: "ersp_engaged", satisfied: true, evidenceRef: "doc://ersp" },
    ]);
    expect(decision.activatable).toBe(false);
    if (!decision.activatable) {
      expect(decision.missing).toHaveLength(OFFERING_PRECONDITIONS.length - 1);
    }
  });

  it("AC-33: ERSP confirmation does not stand in for the legal issuance decision", () => {
    const decision = checkOfferingGate(allSatisfiedExcept("legal_issuance_decision"));
    expect(decision.activatable).toBe(false);
    if (!decision.activatable) {
      expect(decision.missing.map((item) => item.key)).toEqual(["legal_issuance_decision"]);
    }
  });
});
