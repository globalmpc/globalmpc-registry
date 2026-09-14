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
 * suspended로 갈 수 있는 상태 — `any eligible state → suspended`.
 * draft는 아직 등록 전이라 정지할 대상이 없고, retired는 이미 종료됐다.
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
    // 복귀 대상은 suspend 직전 상태다. 전이표는 가능한 집합만 정의하고
    // 실제 복귀는 resumeFromSuspension이 판정한다.
    suspended: [...SUSPENDABLE_STATES, "closure"],
  },
};

/**
 * suspended에서의 복귀.
 *
 * `suspended → prior_state 또는 closure`(§4.3)만 허용한다. 임의 상태로 복귀하면
 * suspension이 상태를 세탁하는 수단이 된다.
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
    // 서명 이후에는 본문을 수정할 수 없다. 정정은 새 attestation의 supersede다
    // (§2.4 규칙 4, 불변조건 4).
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
    // voting 이후 cancelled가 없다 — tally 확정 후 관리자 취소를 막는다(§4.5).
    voting: ["succeeded", "defeated", "no_quorum"],
    succeeded: ["timelocked"],
    defeated: [],
    no_quorum: [],
    timelocked: ["recorded"],
    recorded: ["execution_pending"],
    // 온체인 결과와 오프체인 집행의 간극(§4.5, AC-06).
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

/** Source Receipt 처리 lifecycle — spec 04 §4.9. source result와 직교한다. */
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
    // schema drift는 healthy로 직행할 수 없다. reconciliation을 거쳐야 한다(AC-19).
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
    // 재검토가 끝나면 active로 돌아갈 수 있다. 과거 서명 사실은 지우지 않는다.
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
    // included는 성공이 아니다. confirmation depth를 충족해야 confirmed다(§6.8).
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
