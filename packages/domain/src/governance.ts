/**
 * 두 Governance Space의 격리 — spec 04 §4.6(5·6) / 08 §8.7 / 09.
 *
 * Protocol과 Project는 화면만 나누는 것이 아니라 contract·storage·voter 명부·
 * 실행 대상까지 분리한다. 이 모듈은 그 격리의 도메인 측 판정이며, 같은 규칙이
 * API route(07 §7.2)와 contract target allowlist(08 §8.7)에서 독립적으로 다시
 * 검사된다. 한 곳이 뚫려도 나머지 두 곳에서 막히도록 3중으로 둔다(AC-05).
 */

export type GovernanceSpace = "protocol" | { readonly kind: "project"; readonly projectId: string };

export const PROTOCOL_PROPOSAL_TYPES = [
  "project_onboarding_support",
  "fee_schedule",
  "listing_policy",
  "minimum_dataset_standard",
  "reviewer_pool_criteria",
  "framework_revision",
  "protocol_treasury",
  "jurisdiction_priority",
  "authority_policy",
  "attestation_schema_approval",
] as const;
export type ProtocolProposalType = (typeof PROTOCOL_PROPOSAL_TYPES)[number];

export const PROJECT_PROPOSAL_TYPES = [
  "branch_continue_or_divest",
  "independent_valuation_request",
  "project_disposition",
  "project_disclosure_acknowledgement",
] as const;
export type ProjectProposalType = (typeof PROJECT_PROPOSAL_TYPES)[number];

export type ProposalType = ProtocolProposalType | ProjectProposalType;

export type GovernanceDenyReason =
  | "GOVERNANCE_SPACE_MISMATCH"
  | "GOVERNANCE_UNKNOWN_PROPOSAL_TYPE"
  | "GOVERNANCE_PROJECT_SCOPE_MISMATCH";

export type SpaceCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: GovernanceDenyReason };

function isProtocolType(type: string): type is ProtocolProposalType {
  return (PROTOCOL_PROPOSAL_TYPES as readonly string[]).includes(type);
}

function isProjectType(type: string): type is ProjectProposalType {
  return (PROJECT_PROPOSAL_TYPES as readonly string[]).includes(type);
}

/**
 * proposal type이 이 space에서 생성 가능한가.
 *
 * protocol voter가 project sale을 제안하는 경로와 그 반대를 모두 막는다.
 */
export function checkProposalSpace(space: GovernanceSpace, type: string): SpaceCheck {
  if (!isProtocolType(type) && !isProjectType(type)) {
    return { allowed: false, reason: "GOVERNANCE_UNKNOWN_PROPOSAL_TYPE" };
  }

  if (space === "protocol") {
    return isProtocolType(type)
      ? { allowed: true }
      : { allowed: false, reason: "GOVERNANCE_SPACE_MISMATCH" };
  }

  return isProjectType(type)
    ? { allowed: true }
    : { allowed: false, reason: "GOVERNANCE_SPACE_MISMATCH" };
}

/**
 * 투표 자격.
 *
 * project voter는 **해당** 프로젝트의 AT snapshot에서만 투표한다. 다른 프로젝트나
 * protocol에는 투표할 수 없다(02 §2.2 `project_voter` 금지 항목).
 */
export function checkVoteEligibility(
  voterSpace: GovernanceSpace,
  proposalSpace: GovernanceSpace,
): SpaceCheck {
  if (voterSpace === "protocol" && proposalSpace === "protocol") {
    return { allowed: true };
  }
  if (voterSpace === "protocol" || proposalSpace === "protocol") {
    return { allowed: false, reason: "GOVERNANCE_SPACE_MISMATCH" };
  }
  return voterSpace.projectId === proposalSpace.projectId
    ? { allowed: true }
    : { allowed: false, reason: "GOVERNANCE_PROJECT_SCOPE_MISMATCH" };
}

/**
 * 어느 space에서도 생성할 수 없는 대상.
 *
 * 설계 개요 다이어그램의 `Forbidden` 노드 — readiness override,
 * legal issuance 승인, 다른 project의 권리 변경. governance vote는 오프체인
 * authority·access·법률 사실을 만들지 않는다(12 §12.13 R4 exit criteria).
 */
export const FORBIDDEN_GOVERNANCE_TARGETS = [
  "readiness_override",
  "legal_issuance_approval",
  "other_project_rights_change",
  "authority_acceptance_bypass",
  "attestation_content_change",
  "audit_log_mutation",
] as const;
export type ForbiddenGovernanceTarget = (typeof FORBIDDEN_GOVERNANCE_TARGETS)[number];

export function isForbiddenTarget(target: string): target is ForbiddenGovernanceTarget {
  return (FORBIDDEN_GOVERNANCE_TARGETS as readonly string[]).includes(target);
}

/**
 * 투표 집계 — spec 04 §4.5.
 *
 * 정족수와 통과 기준을 분리해 판정한다. 둘을 합치면 "참여가 부족해서"와
 * "반대가 많아서"가 같은 결과로 보이는데, 다음에 할 일이 다르다 —
 * 전자는 다시 알리는 것이고 후자는 제안을 고치는 것이다.
 *
 * **분수로 계산한다.** 부동소수점을 쓰면 경계값에서 결과가 갈린다.
 */
export interface TallyInput {
  readonly forWeight: bigint;
  readonly againstWeight: bigint;
  readonly abstainWeight: bigint;
  /** 투표 가능한 전체 무게. 정족수의 분모다. */
  readonly eligibleWeight: bigint;
  readonly quorumNumerator: number;
  readonly quorumDenominator: number;
  readonly thresholdNumerator: number;
  readonly thresholdDenominator: number;
}

export type TallyOutcome = "succeeded" | "defeated" | "no_quorum";

export interface TallyResult {
  readonly outcome: TallyOutcome;
  readonly participatedWeight: bigint;
  readonly quorumMet: boolean;
  readonly thresholdMet: boolean;
  /** 왜 이 결과인지. 화면이 추측하지 않게 서버가 말한다. */
  readonly reason: string;
}

export function tallyVotes(input: TallyInput): TallyResult {
  // 기권도 참여다. 정족수는 "얼마나 관심을 보였나"이지 "얼마나 찬성했나"가 아니다.
  const participated = input.forWeight + input.againstWeight + input.abstainWeight;

  const quorumMet =
    participated * BigInt(input.quorumDenominator) >=
    input.eligibleWeight * BigInt(input.quorumNumerator);

  if (!quorumMet) {
    return {
      outcome: "no_quorum",
      participatedWeight: participated,
      quorumMet: false,
      thresholdMet: false,
      reason: "참여 무게가 정족수에 못 미친다",
    };
  }

  // 통과 기준의 분모는 찬반 합이다. 기권을 반대로 세면 기권의 의미가 사라진다.
  const decided = input.forWeight + input.againstWeight;
  const thresholdMet =
    decided > 0n &&
    input.forWeight * BigInt(input.thresholdDenominator) >=
      decided * BigInt(input.thresholdNumerator);

  return {
    outcome: thresholdMet ? "succeeded" : "defeated",
    participatedWeight: participated,
    quorumMet: true,
    thresholdMet,
    reason: thresholdMet
      ? "정족수와 통과 기준을 모두 충족했다"
      : decided === 0n
        ? "기권만 있어 찬반 판정이 불가능하다"
        : "찬성이 통과 기준에 못 미친다",
  };
}
