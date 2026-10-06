import { describe, expect, it } from "vitest";
import { childrenByParent, validityText } from "../src/lib/documents";

/**
 * Document-relations screen helpers.
 *
 * Three screens read validity and trees through these. A wrong day count or a dropped branch
 * would show on all three at once.
 */
describe("document relation helpers", () => {
  it("states validity as a fact, with no warning threshold", () => {
    expect(validityText(null)).toBe("—");
    expect(validityText("2020-01-31", -3)).toBe("Expired 2020-01-31");
    expect(validityText("2031-05-01", 0)).toBe("2031-05-01 · last valid day");
    expect(validityText("2031-05-01", 1)).toBe("2031-05-01 · 1 day left");
    expect(validityText("2031-05-01", 400)).toBe("2031-05-01 · 400 days left");
  });

  it("rebuilds the tree from the document above each one", () => {
    const children = childrenByParent([
      { uploadId: "report", viaUploadId: "license" },
      { uploadId: "summary", viaUploadId: "report" },
      { uploadId: "memo", viaUploadId: "license" },
      // The expired document itself sits at the root, not under anything.
      { uploadId: "license", viaUploadId: null },
    ]);

    expect(children.get("license")?.map((item) => item.uploadId)).toEqual(["report", "memo"]);
    expect(children.get("report")?.map((item) => item.uploadId)).toEqual(["summary"]);
    expect(children.has("memo")).toBe(false);
  });
});
