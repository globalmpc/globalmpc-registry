import type { StateMachine } from "./state-machine.js";

/** AT/Project lifecycle — spec 04 §4.3. */
export const AT_LIFECYCLE_STATES = [
  "draft",
  "registered",
  "offering_open",
  "offering_closed",
  "active",
  "branch_vote",
  "continuing",
  "divested",
  "closure",
  "retired",
  "suspended",
] as const;
export type AtLifecycleState = (typeof AT_LIFECYCLE_STATES)[number];

/**
 * States that may move to suspended — `any eligible state → suspended`.
 * draft is not yet registered so there is nothing to suspend; retired has already ended.
 */
export const SUSPENDABLE_STATES: readonly AtLifecycleState[] = [
  "registered",
  "offering_open",
  "offering_closed",
  "active",
  "branch_vote",
  "continuing",
  "divested",
  "closure",
];

export const atLifecycleMachine: StateMachine<AtLifecycleState> = {
  name: "at_lifecycle",
  initial: "draft",
  states: AT_LIFECYCLE_STATES,
  transitions: {
    draft: ["registered"],
    registered: ["offering_open", "suspended"],
    offering_open: ["offering_closed", "suspended"],
    offering_closed: ["active", "suspended"],
    active: ["branch_vote", "closure", "suspended"],
    branch_vote: ["continuing", "divested", "suspended"],
    continuing: ["active", "branch_vote", "suspended"],
    divested: ["closure", "suspended"],
    closure: ["retired", "suspended"],
    retired: [],
    // The resume target is the state just before suspension. The transition table defines only
    // the possible set; resumeFromSuspension decides the actual resume.
    suspended: [...SUSPENDABLE_STATES, "closure"],
  },
};

/**
 * Resuming from suspended.
 *
 * Only `suspended → prior_state or closure` (§4.3) is allowed. Resuming into an arbitrary state
 * would make suspension a way to launder state.
 */
export function resumeFromSuspension(
  priorState: AtLifecycleState,
  target: AtLifecycleState,
): boolean {
  if (target === "closure") return true;
  return target === priorState && SUSPENDABLE_STATES.includes(priorState);
}

/** Verification Case — spec 04 §4.4. */
export const VERIFICATION_CASE_STATES = [
  "draft",
  "assigned",
  "in_review",
  "changes_requested",
  "signed",
  "registered",
  "declined",
  "cancelled",
  "superseded",
  "revoked",
] as const;
export type VerificationCaseState = (typeof VERIFICATION_CASE_STATES)[number];

export const verificationCaseMachine: StateMachine<VerificationCaseState> = {
  name: "verification_case",
  initial: "draft",
  states: VERIFICATION_CASE_STATES,
  transitions: {
    draft: ["assigned", "cancelled"],
    assigned: ["in_review", "declined", "cancelled"],
    in_review: ["changes_requested", "signed", "cancelled"],
    changes_requested: ["in_review", "cancelled"],
    // The body cannot be edited after signing. A correction is a supersede by a new attestation
    // (§2.4 rule 4, invariant 4).
    signed: ["registered", "revoked", "superseded"],
    registered: ["revoked", "superseded"],
    declined: [],
    cancelled: [],
    superseded: [],
    revoked: [],
  },
};

/** Governance Proposal — spec 04 §4.5. */
export const PROPOSAL_STATES = [
  "draft",
  "review",
  "announced",
  "voting",
  "succeeded",
  "defeated",
  "no_quorum",
  "timelocked",
  "recorded",
  "execution_pending",
  "executed",
  "failed",
  "disputed",
  "cancelled",
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const proposalMachine: StateMachine<ProposalState> = {
  name: "proposal",
  initial: "draft",
  states: PROPOSAL_STATES,
  transitions: {
    draft: ["review", "cancelled"],
    review: ["announced", "cancelled"],
    announced: ["voting", "cancelled"],
    // No cancelled after voting — blocks admin cancellation once the tally is final (§4.5).
    voting: ["succeeded", "defeated", "no_quorum"],
    succeeded: ["timelocked"],
    defeated: [],
    no_quorum: [],
    timelocked: ["recorded"],
    recorded: ["execution_pending"],
    // The gap between the on-chain result and off-chain execution (§4.5, AC-06).
    execution_pending: ["executed", "failed", "disputed"],
    executed: [],
    failed: [],
    disputed: ["executed", "failed"],
    cancelled: [],
  },
};

/** Authority — spec 04 §4.9. */
export const AUTHORITY_STATES = [
  "proposed",
  "under_review",
  "accepted",
  "suspended",
  "expired",
  "revoked",
  "superseded",
] as const;
export type AuthorityState = (typeof AUTHORITY_STATES)[number];

export const authorityMachine: StateMachine<AuthorityState> = {
  name: "authority",
  initial: "proposed",
  states: AUTHORITY_STATES,
  transitions: {
    proposed: ["under_review", "revoked"],
    under_review: ["accepted", "revoked"],
    accepted: ["suspended", "expired", "revoked", "superseded"],
    suspended: ["accepted", "revoked", "expired"],
    expired: ["superseded"],
    revoked: [],
    superseded: [],
  },
};

/** Source Connection lifecycle — spec 04 §4.9. */
export const SOURCE_CONNECTION_STATES = [
  "planned",
  "feasibility_checked",
  "access_confirmed",
  "tested",
  "active",
  "degraded",
  "disabled",
] as const;
export type SourceConnectionState = (typeof SOURCE_CONNECTION_STATES)[number];

export const sourceConnectionMachine: StateMachine<SourceConnectionState> = {
  name: "source_connection",
  initial: "planned",
  states: SOURCE_CONNECTION_STATES,
  transitions: {
    planned: ["feasibility_checked", "disabled"],
    feasibility_checked: ["access_confirmed", "disabled"],
    access_confirmed: ["tested", "disabled"],
    tested: ["active", "disabled"],
    active: ["degraded", "disabled"],
    degraded: ["active", "disabled"],
    disabled: [],
  },
};

/** Source Receipt processing lifecycle — spec 04 §4.9. Orthogonal to source result. */
export const RECEIPT_PROCESSING_STATES = [
  "requested",
  "received",
  "authenticated",
  "schema_validated",
  "normalized",
  "classified",
  "reconciled",
  "quarantined",
] as const;
export type ReceiptProcessingState = (typeof RECEIPT_PROCESSING_STATES)[number];

export const receiptProcessingMachine: StateMachine<ReceiptProcessingState> = {
  name: "source_receipt_processing",
  initial: "requested",
  states: RECEIPT_PROCESSING_STATES,
  transitions: {
    requested: ["received", "quarantined"],
    received: ["authenticated", "quarantined"],
    authenticated: ["schema_validated", "quarantined"],
    schema_validated: ["normalized", "quarantined"],
    normalized: ["classified", "quarantined"],
    classified: ["reconciled", "quarantined"],
    reconciled: [],
    quarantined: [],
  },
};

/** Adapter health — spec 04 §4.9. */
export const ADAPTER_HEALTH_STATES = [
  "healthy",
  "degraded",
  "schema_changed",
  "unavailable",
  "reconciliation_required",
  "disabled",
] as const;
export type AdapterHealthState = (typeof ADAPTER_HEALTH_STATES)[number];

export const adapterHealthMachine: StateMachine<AdapterHealthState> = {
  name: "adapter_health",
  initial: "healthy",
  states: ADAPTER_HEALTH_STATES,
  transitions: {
    healthy: ["degraded", "schema_changed", "unavailable", "disabled"],
    degraded: ["healthy", "reconciliation_required", "disabled"],
    // schema drift cannot go straight to healthy. It must pass through reconciliation (AC-19).
    schema_changed: ["reconciliation_required", "disabled"],
    unavailable: ["healthy", "reconciliation_required", "disabled"],
    reconciliation_required: ["healthy", "disabled"],
    disabled: [],
  },
};

/** Attestation Schema — spec 04 §4.9. */
export const ATTESTATION_SCHEMA_STATES = [
  "draft",
  "approved",
  "active",
  "superseded",
  "retired",
] as const;
export type AttestationSchemaState = (typeof ATTESTATION_SCHEMA_STATES)[number];

export const attestationSchemaMachine: StateMachine<AttestationSchemaState> = {
  name: "attestation_schema",
  initial: "draft",
  states: ATTESTATION_SCHEMA_STATES,
  transitions: {
    draft: ["approved"],
    approved: ["active", "retired"],
    active: ["superseded", "retired"],
    superseded: [],
    retired: [],
  },
};

/** Verification Attestation — spec 04 §4.9. */
export const ATTESTATION_STATES = [
  "draft",
  "signed",
  "active",
  "stale_candidate",
  "superseded",
  "revoked",
  "disputed",
] as const;
export type AttestationState = (typeof ATTESTATION_STATES)[number];

export const attestationMachine: StateMachine<AttestationState> = {
  name: "verification_attestation",
  initial: "draft",
  states: ATTESTATION_STATES,
  transitions: {
    draft: ["signed"],
    signed: ["active", "revoked", "disputed"],
    active: ["stale_candidate", "superseded", "revoked", "disputed"],
    // Once re-review ends it can return to active. The past signature is not erased.
    stale_candidate: ["active", "superseded", "revoked", "disputed"],
    superseded: [],
    revoked: [],
    disputed: ["active", "superseded", "revoked"],
  },
};

/** Compliance Policy — spec 04 §4.9. */
export const POLICY_STATES = ["draft", "approved", "effective", "superseded", "retired"] as const;
export type PolicyState = (typeof POLICY_STATES)[number];

export const compliancePolicyMachine: StateMachine<PolicyState> = {
  name: "compliance_policy",
  initial: "draft",
  states: POLICY_STATES,
  transitions: {
    draft: ["approved"],
    approved: ["effective", "retired"],
    effective: ["superseded", "retired"],
    superseded: [],
    retired: [],
  },
};

/** Jurisdiction Profile — spec 04 §4.9. */
export const JURISDICTION_PROFILE_STATES = [
  "drafting",
  "review_ready",
  "approved",
  "stale",
  "suspended",
] as const;
export type JurisdictionProfileState = (typeof JURISDICTION_PROFILE_STATES)[number];

export const jurisdictionProfileMachine: StateMachine<JurisdictionProfileState> = {
  name: "jurisdiction_profile",
  initial: "drafting",
  states: JURISDICTION_PROFILE_STATES,
  transitions: {
    drafting: ["review_ready"],
    review_ready: ["approved", "drafting"],
    approved: ["stale", "suspended"],
    stale: ["approved", "suspended"],
    suspended: ["approved"],
  },
};

/** Chain transaction — spec 07 §7.7 / 08 §8.9. */
export const CHAIN_TX_STATES = [
  "created",
  "signed",
  "submitted",
  "included",
  "confirmed",
  "replaced",
  "reverted",
  "reorged",
  "dropped",
  "failed",
  "reconciliation_required",
] as const;
export type ChainTxState = (typeof CHAIN_TX_STATES)[number];

export const chainTransactionMachine: StateMachine<ChainTxState> = {
  name: "chain_transaction",
  initial: "created",
  states: CHAIN_TX_STATES,
  transitions: {
    created: ["signed", "failed"],
    signed: ["submitted", "failed"],
    submitted: ["included", "replaced", "dropped", "failed"],
    // included is not success. It is confirmed only once confirmation depth is met (§6.8).
    included: ["confirmed", "reverted", "reorged", "replaced"],
    confirmed: ["reorged"],
    replaced: ["submitted", "failed"],
    reverted: ["reconciliation_required"],
    reorged: ["submitted", "reconciliation_required"],
    dropped: ["submitted", "failed"],
    failed: ["reconciliation_required"],
    reconciliation_required: ["created", "failed"],
  },
};

export const ALL_MACHINES = [
  atLifecycleMachine,
  verificationCaseMachine,
  proposalMachine,
  authorityMachine,
  sourceConnectionMachine,
  receiptProcessingMachine,
  adapterHealthMachine,
  attestationSchemaMachine,
  attestationMachine,
  compliancePolicyMachine,
  jurisdictionProfileMachine,
  chainTransactionMachine,
] as const;
