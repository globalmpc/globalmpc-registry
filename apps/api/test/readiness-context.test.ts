import { describe, expect, it } from "vitest";
import {
  deriveJurisdictionContext,
  deriveProjectContext,
  type ContextClaim,
} from "../src/services/readiness-context.js";

/** Context facts from claims — runs without a database. */
const AS_OF = new Date("2026-09-23T00:00:00Z");

function claim(claimType: string, value: string, overrides: Partial<ContextClaim> = {}): ContextClaim {
  return { claim_type: claimType, value_text: value, grade: "verified", excluded_by_rule: false, stale: false, ...overrides };
}

describe("deriveProjectContext", () => {
  it("nothing recorded — every fact is absent, none defaulted", () => {
    expect(deriveProjectContext([], AS_OF)).toEqual({
      projectStage: undefined,
      offeringIntent: undefined,
      rightsExpiryWithin12Months: undefined,
    });
  });

  it("rejected, excluded or stale claims are not a basis", () => {
    for (const overrides of [{ grade: "rejected" }, { excluded_by_rule: true }, { stale: true }]) {
      const context = deriveProjectContext([claim("project_stage", "exploration_or_later", overrides)], AS_OF);
      expect(context["projectStage"], JSON.stringify(overrides)).toBeUndefined();
    }
  });

  it("offering intent accepts only true or false", () => {
    expect(deriveProjectContext([claim("offering_intent", "maybe")], AS_OF)["offeringIntent"]).toBeUndefined();
    expect(deriveProjectContext([claim("offering_intent", "false")], AS_OF)["offeringIntent"]).toBe("false");
  });

  it("rights expiry: the twelve-month boundary is inclusive and a bad date is absent", () => {
    const expiry = (value: string) =>
      deriveProjectContext([claim("mining_right_expiry", value)], AS_OF)["rightsExpiryWithin12Months"];
    expect(expiry("2027-09-23")).toBe("true");
    expect(expiry("2027-09-24")).toBe("false");
    // Already expired is within twelve months too — it needs watching, not a pass.
    expect(expiry("2026-01-01")).toBe("true");
    expect(expiry("2027-02-30")).toBeUndefined();
    expect(expiry("next year")).toBeUndefined();
  });
});

describe("deriveJurisdictionContext", () => {
  it("has no stored profile to read — nothing is assumed approved", () => {
    const context = deriveJurisdictionContext();
    expect(Object.values(context).every((value) => value === undefined)).toBe(true);
    expect(Object.keys(context).sort()).toEqual([
      "acceptedReportingStandard",
      "environmentalRequirementBasis",
      "jurisdictionProfileState",
    ]);
  });
});
