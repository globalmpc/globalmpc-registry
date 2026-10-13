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
 * The space a voter role binding votes in — 02 §2.2.
 *
 * `protocol_voter` votes on the protocol with MPC weight. `project_voter` votes on **one**
 * project's AT snapshot, so only a binding that names that project has a space. An
 * organization-level `project_voter` binding names no project; reading it as "every project"
 * would let one binding vote on every project's assets (02 §2.2 `project_voter` prohibitions).
 *
 * Other roles do not vote. The MPC operator administers proposals (02 §2.3) and must not make
 * project asset decisions (02 §2.2), so it has no space here.
 */
export function voterSpaceOf(binding: {
  readonly role: string;
  readonly projectId: string | null;
}): GovernanceSpace | null {
  if (binding.role === "protocol_voter") return "protocol";
  if (binding.role === "project_voter" && binding.projectId !== null) {
    return { kind: "project", projectId: binding.projectId };
  }
  return null;
}

/**
 * How a passed proposal takes effect — 09 §9.4 `execution mode`.
 *
 * Fixed at creation so voters know before voting whether a pass changes anything on chain or
 * only starts an off-chain process that someone else must carry out.
 */
export const EXECUTION_MODES = ["record_only", "onchain_bounded", "offchain_required"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Centralization stages — 09 §9.11, in the spec's order.
 *
 * The text is the spec's; nothing here adds dates or thresholds. The criteria for moving
 * between stages are candidates whose values OD-10 to OD-12 have not decided.
 */
export const GOVERNANCE_STAGES = [
  {
    stage: "founder_operated",
    description:
      "The founding team operates the protocol. Redlines cannot be changed and every admin is disclosed.",
    delegates: [],
  },
  {
    stage: "parameter_delegated",
    description: "Bounded parameters such as fees move to governance.",
    delegates: ["bounded_parameters"],
  },
  {
    stage: "policy_delegated",
    description: "Listing and reviewer criteria move to governance.",
    delegates: ["listing_and_reviewer_criteria"],
  },
  {
    stage: "treasury_delegated",
    description:
      "The treasury moves to governance once its threshold and operating record are met.",
    delegates: ["treasury"],
  },
] as const;
export type GovernanceStage = (typeof GOVERNANCE_STAGES)[number]["stage"];

/**
 * The current stage.
 *
 * Every later stage is entered by meeting transition criteria, and no criterion has a value
 * yet (09 §9.11: "values are decided in OD-10 to OD-12", all pending). No transition can have
 * happened, so the protocol is in the first stage. When a value is decided and a transition
 * occurs, this becomes a recorded fact instead of a constant.
 */
export const CURRENT_GOVERNANCE_STAGE: GovernanceStage = "founder_operated";

/** Candidate criteria for moving between stages — 09 §9.11. No values are decided. */
export const STAGE_TRANSITION_CRITERIA_CANDIDATES = [
  "active_project_count",
  "mpc_holder_distribution",
  "turnout",
  "incident_free_period",
  "audit_maturity",
] as const;

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
