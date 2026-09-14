// AC-25: Core schema·route·state에 Mongolia-specific 기관명이 없다.
// 두 번째 profile을 실제로 load해 workflow를 돌리는 것은 아직 없다.
import { describe, expect, it } from "vitest";
import {
  checkAdapterAvailable,
  toReceiptInput,
  validateProfile,
  type AdapterDescriptor,
} from "../src/adapter.js";

/**
 * Evidence Adapter Framework — 05 §5.12, OD-42·OD-43.
 *
 * 핵심은 **미확인 연동을 활성으로 보이게 하지 않는다**는 것이다. 목록에서 빼면
 * "왜 이 기관은 없나"를 알 수 없고, 활성으로 두면 있지도 않은 연동을 약속한다.
 */

const base: AdapterDescriptor = {
  connectionKey: "mn-mineral-registry",
  authorityName: "Mineral Resources Authority",
  jurisdiction: "MNG",
  state: "active",
  proves: ["mining_right_registration"],
  doesNotProve: ["economic_viability", "rights_completeness"],
  stateReason: "",
};

describe("adapter 호출 가능 여부", () => {
  it("active만 호출된다", () => {
    expect(checkAdapterAvailable(base)).toEqual({ callable: true });
  });

  it("manual은 막힌 것이 아니라 사람이 하는 것이다", () => {
    // 수동 확인을 장애처럼 보이게 하면 운영자가 원인을 찾으려 든다.
    const result = checkAdapterAvailable({ ...base, state: "manual", stateReason: "API 없음" });
    expect(result.callable).toBe(false);
    if (!result.callable) {
      expect(result.reason).toBe("MANUAL_COLLECTION_ONLY");
      expect(result.nextAction).toContain("수동");
    }
  });

  it("접근 권한이 없으면 호출하지 않는다", () => {
    // OD-42가 해소되기 전까지 호출하면 미확인 통합을 약속하는 것이 된다.
    const result = checkAdapterAvailable({
      ...base,
      state: "pending_access",
      stateReason: "협의 중",
    });
    expect(result.callable).toBe(false);
    if (!result.callable) expect(result.reason).toBe("ACCESS_NOT_GRANTED");
  });

  it("법적으로 막힌 것과 접근 미승인을 구분한다", () => {
    const blocked = checkAdapterAvailable({ ...base, state: "blocked", stateReason: "법무 보류" });
    const pending = checkAdapterAvailable({
      ...base,
      state: "pending_access",
      stateReason: "협의 중",
    });

    // 다음에 할 일이 다르다 — 하나는 법무, 하나는 기관 협의다.
    expect(blocked).not.toEqual(pending);
  });
});

describe("receipt 입력 변환", () => {
  it("authority의 한계가 반드시 들어간다", () => {
    // adapter가 빠뜨려도 authority가 선언한 것은 붙는다.
    const input = toReceiptInput(base, {
      kind: "outcome",
      outcome: {
        result: "confirmed_from_source",
        rawHash: `0x${"ab".repeat(32)}`,
        queryBasis: { licenseNumber: "MV-1" },
        limitations: [],
        effectiveAt: "2026-01-01T00:00:00Z",
      },
    });

    expect(input.limitations).toContain("economic_viability");
    expect(input.limitations).toContain("rights_completeness");
  });

  it("adapter가 더한 한계와 합쳐지고 중복되지 않는다", () => {
    const input = toReceiptInput(base, {
      kind: "outcome",
      outcome: {
        result: "confirmed_from_source",
        rawHash: `0x${"ab".repeat(32)}`,
        queryBasis: {},
        limitations: ["economic_viability", "이 조회는 현재 상태만 확인한다"],
        effectiveAt: null,
      },
    });

    expect(input.limitations).toContain("이 조회는 현재 상태만 확인한다");
    expect(input.limitations.filter((item) => item === "economic_viability")).toHaveLength(1);
  });

  it("실패한 조회도 한계를 잃지 않는다", () => {
    // 실패를 "확인 안 됨"으로만 남기면 무엇을 확인하려 했는지 잃는다.
    const input = toReceiptInput(base, {
      kind: "failed",
      result: "source_unavailable",
      detail: "timeout",
    });

    expect(input.result).toBe("source_unavailable");
    expect(input.limitations).toContain("economic_viability");
    expect(input.rawHash).toBeNull();
  });
});

describe("profile 검증", () => {
  it("한계를 선언하지 않은 adapter를 거절한다", () => {
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, doesNotProve: [] }],
    });
    expect(issues.some((issue) => issue.problem.includes("doesNotProve"))).toBe(true);
  });

  it("비활성 상태에 이유가 없으면 지적한다", () => {
    // "왜 이 기관은 안 되나"에 답할 수 없으면 미확인 통합으로 보인다.
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, state: "pending_access", stateReason: "" }],
    });
    expect(issues.some((issue) => issue.problem.includes("이유가 필요"))).toBe(true);
  });

  it("관할이 어긋나면 지적한다", () => {
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, jurisdiction: "AUS" }],
    });
    expect(issues.some((issue) => issue.problem.includes("관할"))).toBe(true);
  });

  it("connectionKey 중복을 지적한다", () => {
    const issues = validateProfile({ jurisdiction: "MNG", adapters: [base, base] });
    expect(issues.some((issue) => issue.problem.includes("중복"))).toBe(true);
  });

  it("활성 adapter가 없어도 유효하다", () => {
    // 접근 협의 중인 관할이 그렇다. 빈 profile을 오류로 만들면 그 사실을
    // 기록할 자리가 없어진다.
    const issues = validateProfile({
      jurisdiction: "MNG",
      adapters: [{ ...base, state: "pending_access", stateReason: "협의 중" }],
    });
    expect(issues).toEqual([]);
  });
});
