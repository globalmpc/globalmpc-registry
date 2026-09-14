import { describe, expect, it } from "vitest";
import { visibleNav } from "../src/lib/nav.js";
import { blockExplorerTxUrl } from "../src/lib/wallet.js";

/** 메뉴 노출 — spec 11 §11.2. */
describe("visibleNav", () => {
  const labels = (session: Parameters<typeof visibleNav>[0]) =>
    visibleNav(session).map((entry) => entry.label);

  it("세션 action에 없는 화면은 보이지 않는다", () => {
    const steward = labels({
      subjectId: "s-1",
      actions: ["project.read", "registry.read", "authority.read", "governance.read"],
    });
    expect(steward).toContain("Projects");
    expect(steward).not.toContain("Audit");
    expect(steward).not.toContain("Admin");
  });

  it("주체가 있으면 역할이 없어도 My Activity가 보인다", () => {
    expect(labels({ subjectId: "s-1", actions: [] })).toEqual(["My Activity"]);
  });

  it("주체도 action도 없으면 아무 워크스페이스 메뉴도 없다", () => {
    expect(labels({ subjectId: null })).toEqual([]);
  });
});

describe("blockExplorerTxUrl", () => {
  const hash = `0x${"ab".repeat(32)}`;

  it("서버가 받는 체인은 BscScan으로 잇는다", () => {
    expect(blockExplorerTxUrl(56, hash)).toBe(`https://bscscan.com/tx/${hash}`);
    expect(blockExplorerTxUrl(97, hash)).toBe(`https://testnet.bscscan.com/tx/${hash}`);
  });

  it("모르는 체인이나 hash가 아닌 값은 링크를 만들지 않는다", () => {
    expect(blockExplorerTxUrl(1, hash)).toBeNull();
    expect(blockExplorerTxUrl(97, "not-a-hash")).toBeNull();
  });
});
