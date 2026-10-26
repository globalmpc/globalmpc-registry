import { expect, it, vi } from "vitest";
import { structuredClaimInput } from "../src/structured-claims.js";

it("rejects oversized document arrays before reading or validating their elements", () => {
  const readElement = vi.fn(() => "not-a-uuid");
  const uploads = Array.from({ length: 21 }, () => "not-a-uuid");
  Object.defineProperty(uploads, 0, { get: readElement });
  const parsed = structuredClaimInput.documentUploadIds.safeParse(uploads);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("Oversized evidence arrays must be rejected");
  expect(parsed.error.issues).toMatchObject([{ code: "too_big", maximum: 20 }]);
  expect(readElement).not.toHaveBeenCalled();
});
