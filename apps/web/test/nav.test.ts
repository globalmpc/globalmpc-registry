import { describe, expect, it } from "vitest";
import { visibleNav } from "../src/lib/nav.js";
import { blockExplorerTxUrl } from "../src/lib/wallet.js";

/** Menu visibility — spec 11 §11.2. */
describe("visibleNav", () => {
  const labels = (session: Parameters<typeof visibleNav>[0]) =>
    visibleNav(session).map((entry) => entry.label);

  it("hides screens whose action is not in the session", () => {
    const steward = labels({
      subjectId: "s-1",
      actions: ["project.read", "registry.read", "authority.read", "governance.read"],
    });
    expect(steward).toContain("Projects");
    expect(steward).not.toContain("Audit");
    expect(steward).not.toContain("Admin");
  });

  it("shows My Activity to a subject even without a role", () => {
    expect(labels({ subjectId: "s-1", actions: [] })).toEqual(["My Activity"]);
  });

  it("shows no workspace menu without a subject or actions", () => {
    expect(labels({ subjectId: null })).toEqual([]);
  });
});

describe("blockExplorerTxUrl", () => {
  const hash = `0x${"ab".repeat(32)}`;

  it("links chains the server accepts to BscScan", () => {
    expect(blockExplorerTxUrl(56, hash)).toBe(`https://bscscan.com/tx/${hash}`);
    expect(blockExplorerTxUrl(97, hash)).toBe(`https://testnet.bscscan.com/tx/${hash}`);
  });

  it("makes no link for an unknown chain or a non-hash value", () => {
    expect(blockExplorerTxUrl(1, hash)).toBeNull();
    expect(blockExplorerTxUrl(97, "not-a-hash")).toBeNull();
  });
});
