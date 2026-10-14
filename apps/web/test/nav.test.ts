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

  it("lists the per-project screens of §11.2 as global entries, each behind its read action", () => {
    const full = labels({
      subjectId: "s-1",
      actions: ["project.read", "evidence.read", "verification.read", "readiness.read", "authority.read"],
    });
    expect(full).toEqual(
      expect.arrayContaining(["Data Room", "Verification", "Readiness & Gates", "Authorities"]),
    );

    const withoutReadiness = labels({ subjectId: "s-1", actions: ["project.read", "evidence.read"] });
    expect(withoutReadiness).toContain("Data Room");
    expect(withoutReadiness).not.toContain("Readiness & Gates");
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

  it("links BSC mainnet transactions to BscScan", () => {
    expect(blockExplorerTxUrl(56, hash)).toBe(`https://bscscan.com/tx/${hash}`);
  });

  it("makes no link for the local chain, an unknown chain, or a non-hash value", () => {
    expect(blockExplorerTxUrl(31337, hash)).toBeNull();
    expect(blockExplorerTxUrl(97, hash)).toBeNull();
    expect(blockExplorerTxUrl(1, hash)).toBeNull();
    expect(blockExplorerTxUrl(56, "not-a-hash")).toBeNull();
  });
});
