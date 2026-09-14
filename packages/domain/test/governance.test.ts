import { describe, expect, it } from "vitest";
import {
  PROJECT_PROPOSAL_TYPES,
  PROTOCOL_PROPOSAL_TYPES,
  checkProposalSpace,
  tallyVotes,
  checkVoteEligibility,
  isForbiddenTarget,
  type GovernanceSpace,
} from "../src/governance.js";

const PROJECT_A: GovernanceSpace = { kind: "project", projectId: "01JZPROJECTA" };
const PROJECT_B: GovernanceSpace = { kind: "project", projectId: "01JZPROJECTB" };

describe("AC-05 — cross-governance 차단", () => {
  it("protocol space에서 project disposition을 제안할 수 없다", () => {
    const result = checkProposalSpace("protocol", "project_disposition");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("GOVERNANCE_SPACE_MISMATCH");
  });

  it("project space에서 protocol treasury를 제안할 수 없다", () => {
    const result = checkProposalSpace(PROJECT_A, "protocol_treasury");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("GOVERNANCE_SPACE_MISMATCH");
  });

  it("project space에서 fee schedule을 바꿀 수 없다", () => {
    expect(checkProposalSpace(PROJECT_A, "fee_schedule").allowed).toBe(false);
  });

  it("project space에서 reviewer pool 기준을 바꿀 수 없다", () => {
    expect(checkProposalSpace(PROJECT_A, "reviewer_pool_criteria").allowed).toBe(false);
  });

  it("모든 protocol type은 protocol space에서만 허용된다", () => {
    for (const type of PROTOCOL_PROPOSAL_TYPES) {
      expect(checkProposalSpace("protocol", type).allowed).toBe(true);
      expect(checkProposalSpace(PROJECT_A, type).allowed).toBe(false);
    }
  });

  it("모든 project type은 project space에서만 허용된다", () => {
    for (const type of PROJECT_PROPOSAL_TYPES) {
      expect(checkProposalSpace(PROJECT_A, type).allowed).toBe(true);
      expect(checkProposalSpace("protocol", type).allowed).toBe(false);
    }
  });

  it("알 수 없는 proposal type을 거절한다", () => {
    const result = checkProposalSpace("protocol", "arbitrary_admin_action");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("GOVERNANCE_UNKNOWN_PROPOSAL_TYPE");
  });
});

describe("투표 자격", () => {
  it("protocol voter는 protocol proposal에만 투표한다", () => {
    expect(checkVoteEligibility("protocol", "protocol").allowed).toBe(true);
    expect(checkVoteEligibility("protocol", PROJECT_A).allowed).toBe(false);
  });

  it("project voter는 protocol proposal에 투표할 수 없다", () => {
    expect(checkVoteEligibility(PROJECT_A, "protocol").allowed).toBe(false);
  });

  it("project voter는 자기 프로젝트에만 투표한다", () => {
    expect(checkVoteEligibility(PROJECT_A, PROJECT_A).allowed).toBe(true);
    const cross = checkVoteEligibility(PROJECT_A, PROJECT_B);
    expect(cross.allowed).toBe(false);
    if (!cross.allowed) expect(cross.reason).toBe("GOVERNANCE_PROJECT_SCOPE_MISMATCH");
  });
});

describe("어느 space에서도 금지되는 대상", () => {
  it("readiness override는 governance로 만들 수 없다", () => {
    expect(isForbiddenTarget("readiness_override")).toBe(true);
  });

  it("legal issuance 승인은 governance로 만들 수 없다", () => {
    expect(isForbiddenTarget("legal_issuance_approval")).toBe(true);
  });

  it("audit log 변경은 governance로 만들 수 없다", () => {
    expect(isForbiddenTarget("audit_log_mutation")).toBe(true);
  });

  it("attestation 내용 변경은 governance로 만들 수 없다", () => {
    expect(isForbiddenTarget("attestation_content_change")).toBe(true);
  });

  it("정상 protocol parameter는 금지 대상이 아니다", () => {
    expect(isForbiddenTarget("fee_schedule")).toBe(false);
  });
});

describe("proposal type 집합의 배타성", () => {
  it("두 집합이 겹치지 않는다", () => {
    const protocol = new Set<string>(PROTOCOL_PROPOSAL_TYPES);
    const overlap = PROJECT_PROPOSAL_TYPES.filter((type) => protocol.has(type));
    expect(overlap).toEqual([]);
  });
});

describe("투표 집계", () => {
  const base = {
    forWeight: 0n,
    againstWeight: 0n,
    abstainWeight: 0n,
    eligibleWeight: 1000n,
    quorumNumerator: 1,
    quorumDenominator: 4,
    thresholdNumerator: 1,
    thresholdDenominator: 2,
  };

  it("참여가 정족수에 못 미치면 no_quorum이다", () => {
    const result = tallyVotes({ ...base, forWeight: 100n });
    // 100/1000 = 10% < 25%
    expect(result.outcome).toBe("no_quorum");
    expect(result.quorumMet).toBe(false);
  });

  it("정족수 미달과 부결을 구분한다", () => {
    // 다음에 할 일이 다르다 — 전자는 다시 알리는 것이고 후자는 제안을 고치는 것이다.
    const noQuorum = tallyVotes({ ...base, forWeight: 100n });
    const defeated = tallyVotes({ ...base, forWeight: 100n, againstWeight: 400n });

    expect(noQuorum.outcome).toBe("no_quorum");
    expect(defeated.outcome).toBe("defeated");
    expect(noQuorum.reason).not.toBe(defeated.reason);
  });

  it("기권도 참여로 센다", () => {
    // 정족수는 "얼마나 관심을 보였나"이지 "얼마나 찬성했나"가 아니다.
    const result = tallyVotes({ ...base, forWeight: 200n, abstainWeight: 100n });
    expect(result.quorumMet).toBe(true);
    expect(result.participatedWeight).toBe(300n);
  });

  it("기권을 반대로 세지 않는다", () => {
    // 300 찬성 / 0 반대 / 200 기권 → 찬반 합 300 중 300이 찬성이라 통과다.
    const result = tallyVotes({ ...base, forWeight: 300n, abstainWeight: 200n });
    expect(result.outcome).toBe("succeeded");
  });

  it("기권만 있으면 판정하지 않는다", () => {
    const result = tallyVotes({ ...base, abstainWeight: 500n });
    expect(result.outcome).toBe("defeated");
    expect(result.reason).toContain("기권만");
  });

  it("경계값에서 분수로 판정한다", () => {
    // 정확히 25%. 부동소수점이면 0.25 비교에서 갈릴 수 있다.
    const exact = tallyVotes({ ...base, forWeight: 250n });
    expect(exact.quorumMet).toBe(true);

    const justBelow = tallyVotes({ ...base, forWeight: 249n });
    expect(justBelow.quorumMet).toBe(false);
  });

  it("통과 기준도 경계에서 정확하다", () => {
    // 찬반 합 500 중 정확히 250 찬성 = 50%. 기준이 1/2이므로 통과다.
    const exact = tallyVotes({ ...base, forWeight: 250n, againstWeight: 250n });
    expect(exact.outcome).toBe("succeeded");

    const justBelow = tallyVotes({ ...base, forWeight: 249n, againstWeight: 251n });
    expect(justBelow.outcome).toBe("defeated");
  });

  it("큰 수에서도 정확하다", () => {
    // 토큰 무게는 18 decimals다. number로 다루면 정밀도를 잃는다.
    const huge = 10n ** 30n;
    const result = tallyVotes({
      ...base,
      eligibleWeight: huge * 4n,
      forWeight: huge,
    });
    expect(result.quorumMet).toBe(true);
  });
});
