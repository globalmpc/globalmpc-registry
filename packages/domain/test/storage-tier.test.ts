import { describe, expect, it } from "vitest";
import { admitToStorage, storageTierFor } from "../src/storage-tier.js";
import { SENSITIVITY_LEVELS } from "../src/disclosure.js";

/**
 * Storage level gate — OD-17·OD-18 (draft decision of 2026-08-14).
 *
 * The draft storage path uses a provider-managed key, with no per-tenant separation or
 * destruction procedure. Checks that only material for which that suffices can pass.
 */
describe("storage level", () => {
  it("the draft path accepts public and restricted", () => {
    expect(storageTierFor("public")).toBe("draft");
    expect(storageTierFor("restricted")).toBe("draft");
  });

  it("sensitive levels require the secured path", () => {
    for (const level of ["confidential", "pii", "whistleblower"] as const) {
      expect(storageTierFor(level)).toBe("secured");
    }
  });

  it("every level is decided as one of the two", () => {
    // If a new level appears without a decision, the default becomes `draft` and it passes silently.
    for (const level of SENSITIVITY_LEVELS) {
      expect(["draft", "secured"]).toContain(storageTierFor(level));
    }
  });

  it("says what to do when rejecting", () => {
    const result = admitToStorage("pii");
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      // Saying only "no" leaves the next action to guesswork.
      expect(result.nextAction).toContain("secured route");
      expect(result.reason).toContain("key separation");
    }
  });

  it("states which path when accepting", () => {
    const result = admitToStorage("restricted");
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.tier).toBe("draft");
  });
});
