import { describe, expect, it } from "vitest";
import {
  DOCUMENT_REQUIREMENT_TIERS,
  requirementStatus,
  summarizeTiers,
  type RequirementCounts,
} from "../src/document-requirements.js";

const none: RequirementCounts = { current: 0, expired: 0, pending: 0 };

describe("requirementStatus", () => {
  it("is met while one current document of the type exists, whatever else is expired", () => {
    expect(requirementStatus({ current: 1, expired: 3, pending: 2 })).toBe("met");
  });

  it("is expired when every promoted document of the type has passed its date", () => {
    expect(requirementStatus({ current: 0, expired: 2, pending: 0 })).toBe("expired");
  });

  // A renewal still in quarantine does not cover an expired licence — nobody can rely on it yet.
  it("stays expired while the renewal is still pending", () => {
    expect(requirementStatus({ current: 0, expired: 1, pending: 1 })).toBe("expired");
  });

  it("is pending when the only documents are not promoted yet", () => {
    expect(requirementStatus({ current: 0, expired: 0, pending: 1 })).toBe("pending");
  });

  it("is missing when nothing of the type was uploaded", () => {
    expect(requirementStatus(none)).toBe("missing");
  });

  it("refuses counts that cannot come from a database count", () => {
    expect(() => requirementStatus({ current: -1, expired: 0, pending: 0 })).toThrow(RangeError);
    expect(() => requirementStatus({ current: 0.5, expired: 0, pending: 0 })).toThrow(RangeError);
  });
});

describe("summarizeTiers", () => {
  it("lists every tier, empty ones included, in the declared order", () => {
    const tiers = summarizeTiers([]);
    expect(tiers.map((tier) => tier.tier)).toEqual([...DOCUMENT_REQUIREMENT_TIERS]);
    expect(tiers.every((tier) => tier.declared === 0 && !tier.incomplete)).toBe(true);
  });

  it("counts each status per tier", () => {
    const tiers = summarizeTiers([
      { tier: "required", status: "met" },
      { tier: "required", status: "expired" },
      { tier: "required", status: "missing" },
      { tier: "presentation", status: "pending" },
    ]);
    expect(tiers.find((tier) => tier.tier === "required")).toEqual({
      tier: "required",
      declared: 3,
      met: 1,
      expired: 1,
      pending: 0,
      missing: 1,
      incomplete: true,
    });
    expect(tiers.find((tier) => tier.tier === "presentation")).toMatchObject({
      declared: 1,
      pending: 1,
    });
  });

  // Only `required` can leave a project incomplete. A missing presentation deck is worth
  // showing, not a gap.
  it("marks only the required tier incomplete", () => {
    const tiers = summarizeTiers([
      { tier: "user_benefit", status: "missing" },
      { tier: "management", status: "expired" },
    ]);
    expect(tiers.some((tier) => tier.incomplete)).toBe(false);
  });

  it("keeps a required tier with every requirement met complete", () => {
    const tiers = summarizeTiers([{ tier: "required", status: "met" }]);
    expect(tiers.find((tier) => tier.tier === "required")?.incomplete).toBe(false);
  });
});
