// AC-25: Core schema, routes, and state carry no Mongolia-specific institution names.
// Actually loading a second profile and running a workflow does not exist yet.
import { describe, expect, it } from "vitest";
import {
  checkAdapterAvailable,
  toReceiptInput,
  validateProfile,
  type AdapterDescriptor,
} from "../src/adapter.js";

/**
 * Evidence Adapter Framework — 05 §5.12, OD-42·OD-43.
 *
 * The point is **never to make an unverified integration look active**. Drop it from the list
 * and "why is this institution missing" has no answer; mark it active and it promises an integration that does not exist.
 */

const base: AdapterDescriptor = {
  connectionKey: "mn-mineral-registry",
  authorityName: "Mineral Resources Authority",
  jurisdiction: "MNG",
  state: "active",
  proves: ["mining_right_registration"],
  doesNotProve: ["economic_viability", "rights_completeness"],
  stateReason: "",
};

describe("adapter callability", () => {
  it("only active is called", () => {
    expect(checkAdapterAvailable(base)).toEqual({ callable: true });
  });

  it("manual is not blocked — a person does it", () => {
    // Making a manual check look like an outage sends operators hunting for a cause.
    const result = checkAdapterAvailable({ ...base, state: "manual", stateReason: "No API" });
    expect(result.callable).toBe(false);
    if (!result.callable) {
      expect(result.reason).toBe("MANUAL_COLLECTION_ONLY");
      expect(result.nextAction).toContain("manually");
    }
  });

  it("does not call without access", () => {
    // Calling before OD-42 is resolved would promise an unverified integration.
    const result = checkAdapterAvailable({
      ...base,
      state: "pending_access",
      stateReason: "Under negotiation",
    });
    expect(result.callable).toBe(false);
    if (!result.callable) expect(result.reason).toBe("ACCESS_NOT_GRANTED");
  });

  it("distinguishes a legal block from unapproved access", () => {
    const blocked = checkAdapterAvailable({ ...base, state: "blocked", stateReason: "Legal hold" });
    const pending = checkAdapterAvailable({
      ...base,
      state: "pending_access",
      stateReason: "Under negotiation",
    });

    // The next step differs — one is legal, the other is negotiation with the institution.
    expect(blocked).not.toEqual(pending);
  });
});

describe("receipt input conversion", () => {
  it("always includes the authority's limitations", () => {
    // What the authority declared is attached even if the adapter omits it.
    const input = toReceiptInput(base, {
      kind: "outcome",
      outcome: {
        result: "confirmed_from_source",
        rawHash: `0x${"ab".repeat(32)}`,
        queryBasis: { licenseNumber: "MV-1" },
        limitations: [],
        effectiveAt: "2026-01-01T00:00:00Z",
      },
    });

    expect(input.limitations).toContain("economic_viability");
    expect(input.limitations).toContain("rights_completeness");
  });

  it("merges with limitations added by the adapter, without duplicates", () => {
    const input = toReceiptInput(base, {
      kind: "outcome",
      outcome: {
        result: "confirmed_from_source",
        rawHash: `0x${"ab".repeat(32)}`,
        queryBasis: {},
        limitations: ["economic_viability", "This lookup checks only the current state"],
        effectiveAt: null,
      },
    });

    expect(input.limitations).toContain("This lookup checks only the current state");
    expect(input.limitations.filter((item) => item === "economic_viability")).toHaveLength(1);
  });

  it("a failed lookup keeps its limitations", () => {
    // Recording a failure only as "not checked" loses what it tried to check.
    const input = toReceiptInput(base, {
      kind: "failed",
      result: "source_unavailable",
      detail: "timeout",
    });

    expect(input.result).toBe("source_unavailable");
    expect(input.limitations).toContain("economic_viability");
    expect(input.rawHash).toBeNull();
  });
});

describe("profile validation", () => {
  it("rejects an adapter that declares no limitations", () => {
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, doesNotProve: [] }],
    });
    expect(issues.some((issue) => issue.problem.includes("doesNotProve"))).toBe(true);
  });

  it("flags an inactive state without a reason", () => {
    // If "why doesn't this institution work" has no answer, it looks like an unverified integration.
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, state: "pending_access", stateReason: "" }],
    });
    expect(issues.some((issue) => issue.problem.includes("requires a reason"))).toBe(true);
  });

  it("flags a jurisdiction mismatch", () => {
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, jurisdiction: "AUS" }],
    });
    expect(issues.some((issue) => issue.problem.includes("jurisdiction"))).toBe(true);
  });

  it("flags a duplicate connectionKey", () => {
    const issues = validateProfile({ jurisdiction: "MNG", adapters: [base, base] });
    expect(issues.some((issue) => issue.problem.includes("duplicate"))).toBe(true);
  });

  it("is valid with no active adapter", () => {
    // E.g. a jurisdiction whose access is under negotiation. Treating an empty profile as an
    // error would leave nowhere to record that fact.
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, state: "pending_access", stateReason: "Under negotiation" }],
    });
    expect(issues).toEqual([]);
  });
});
