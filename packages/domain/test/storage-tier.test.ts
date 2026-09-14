import { describe, expect, it } from "vitest";
import { admitToStorage, storageTierFor } from "../src/storage-tier.js";
import { SENSITIVITY_LEVELS } from "../src/disclosure.js";

/**
 * 저장 등급 게이트 — OD-17·OD-18 (2026-08-14 초안 결정).
 *
 * 초안 저장 경로는 provider 관리 키를 쓰고 tenant별 분리도 파기 절차도 없다.
 * 그것으로 충분한 자료만 지나갈 수 있는가를 본다.
 */
describe("저장 등급", () => {
  it("public·restricted는 초안 경로가 받는다", () => {
    expect(storageTierFor("public")).toBe("draft");
    expect(storageTierFor("restricted")).toBe("draft");
  });

  it("민감 등급은 secured 경로를 요구한다", () => {
    for (const level of ["confidential", "pii", "whistleblower"] as const) {
      expect(storageTierFor(level)).toBe("secured");
    }
  });

  it("모든 등급이 둘 중 하나로 판정된다", () => {
    // 새 등급이 생겼는데 판정이 빠지면 기본이 `draft`가 되어 조용히 통과한다.
    for (const level of SENSITIVITY_LEVELS) {
      expect(["draft", "secured"]).toContain(storageTierFor(level));
    }
  });

  it("거절할 때 무엇을 해야 하는지 말한다", () => {
    const result = admitToStorage("pii");
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      // "안 된다"만 알려주면 다음 행동을 추측하게 된다.
      expect(result.nextAction).toContain("secured route");
      expect(result.reason).toContain("키 분리");
    }
  });

  it("받을 때는 어느 경로인지 밝힌다", () => {
    const result = admitToStorage("restricted");
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.tier).toBe("draft");
  });
});
