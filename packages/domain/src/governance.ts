/**
 * Isolation of the two Governance Spaces — spec 04 §4.6(5·6) / 08 §8.7 / 09.
 *
 * Protocol and Project are split not only on screen but in contracts, storage, voter rolls,
 * and execution targets. This module is the domain-side check of that isolation; the same rule
 * is re-checked independently in the API routes (07 §7.2) and the contract target allowlist
 * (08 §8.7). Three layers, so a breach in one is still stopped by the other two (AC-05).
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
 * Can this proposal type be created in this space?
 *
 * Blocks both a protocol voter proposing a project sale and the reverse.
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
 * Voting eligibility.
 *
 * A project voter votes only on the AT snapshot of **that** project. It cannot vote on other
 * projects or on the protocol (02 §2.2 `project_voter` prohibitions).
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
 * Targets no space can create.
 *
 * The `Forbidden` node in the design overview diagram — readiness override,
 * legal issuance approval, rights changes to another project. A governance vote does not
 * create off-chain authority, access, or legal facts (12 §12.13 R4 exit criteria).
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
 * Vote tally — spec 04 §4.5.
 *
 * Quorum and pass threshold are decided separately. Merged, "too little participation" and
 * "too many against" look like the same outcome, yet the next step differs — the former
 * means announcing again, the latter means revising the proposal.
 *
 * **Computed as fractions.** Floating point splits outcomes at boundary values.
 */
export interface TallyInput {
  readonly forWeight: bigint;
  readonly againstWeight: bigint;
  readonly abstainWeight: bigint;
  /** Total eligible voting weight. The quorum denominator. */
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
  /** Why this outcome. The server says it so the UI does not guess. */
  readonly reason: string;
}

export function tallyVotes(input: TallyInput): TallyResult {
  // Abstaining is participation. Quorum measures "how much interest", not "how much support".
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
      reason: "Participating weight is below quorum",
    };
  }

  // The pass-threshold denominator is for + against. Counting abstentions as against erases their meaning.
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
      ? "Both quorum and pass threshold are met"
      : decided === 0n
        ? "Only abstentions; for/against cannot be decided"
        : "Support is below the pass threshold",
  };
}
