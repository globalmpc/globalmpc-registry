import { describe, expect, it } from "vitest";
import {
  OFFERING_PRECONDITIONS,
  checkOfferingGate,
  type PreconditionStatus,
} from "../src/offering-gate.js";

/**
 * Asset/Offering activation gate — OD-07.
 *
 * 이 파일이 지키는 것은 **거래 기능이 존재하지 않는다**는 사실이다. gate가
 * 통과해도 코드에 거래 경로가 생기지 않는다 — 조건 판정과 구현은 별개다.
 */

const satisfied = (evidenceRef = "ref"): Omit<PreconditionStatus, "key"> => ({
  satisfied: true,
  evidenceRef,
});

function allSatisfied(): PreconditionStatus[] {
  return OFFERING_PRECONDITIONS.map((precondition) => ({
    key: precondition.key,
    ...satisfied(`doc://${precondition.key}`),
  }));
}

describe("활성화 조건", () => {
  it("아무것도 확인되지 않으면 모든 조건이 남는다", () => {
    const decision = checkOfferingGate([]);
    expect(decision.activatable).toBe(false);
    if (!decision.activatable) {
      expect(decision.missing).toHaveLength(OFFERING_PRECONDITIONS.length);
    }
  });

  it("남은 조건마다 담당과 이유를 알려준다", () => {
    const decision = checkOfferingGate([]);
    if (!decision.activatable) {
      // 빈 화면이나 비활성 버튼 대신 무엇이 남았는지 보여주기 위한 것이다.
      for (const item of decision.missing) {
        expect(item.why.length).toBeGreaterThan(0);
        expect(item.owner.length).toBeGreaterThan(0);
      }
    }
  });

  it("부분 충족으로는 활성화되지 않는다", () => {
    // "송금만 먼저"는 규제 관점에서 전체를 연 것과 같다.
    const partial = allSatisfied().slice(0, 3);
    expect(checkOfferingGate(partial).activatable).toBe(false);
  });

  it("근거 없는 충족 표시를 따로 잡는다", () => {
    // 빠진 것보다 위험하다 — 확인됐다고 믿게 만든다.
    const statuses = allSatisfied().map((status, index) =>
      index === 0 ? { ...status, evidenceRef: null } : status,
    );

    const decision = checkOfferingGate(statuses);
    expect(decision.activatable).toBe(false);
    if (!decision.activatable) {
      expect(decision.unsupported).toContain(OFFERING_PRECONDITIONS[0]!.key);
    }
  });

  it("모든 조건이 근거와 함께 충족되면 활성화 가능으로 판정한다", () => {
    expect(checkOfferingGate(allSatisfied()).activatable).toBe(true);
  });

  it("법적 발행 결정이 별도 조건으로 있다", () => {
    // 데이터 준비도·거버넌스 통과가 발행 승인을 대신하지 않는다.
    const keys = OFFERING_PRECONDITIONS.map((precondition) => precondition.key);
    expect(keys).toContain("legal_issuance_decision");
    expect(keys).toContain("security_audit");
  });
});
