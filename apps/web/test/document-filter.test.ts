import { describe, expect, it } from "vitest";
import { withExpiryWindow, withStatusFilter } from "../src/lib/document-status";

describe("document list filters", () => {
  it("drops the expiry window when a status other than current is chosen", () => {
    expect(withStatusFilter({ expiresWithinDays: 30 }, "expired")).toEqual({
      status: "expired",
      expiresWithinDays: undefined,
    });
    expect(withStatusFilter({ expiresWithinDays: 30 }, "current").expiresWithinDays).toBe(30);
  });

  it("drops a non-current status when an expiry window is set", () => {
    expect(withExpiryWindow({ status: "superseded" }, 30)).toEqual({
      status: undefined,
      expiresWithinDays: 30,
    });
    expect(withExpiryWindow({ status: "current" }, 30).status).toBe("current");
  });
});
