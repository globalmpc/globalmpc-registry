export {
  SOURCE_RESULTS,
  SOURCE_RESULT_BEHAVIOUR,
  COLLECTION_METHODS,
  isSourceResult,
  type SourceResult,
  type SourceResultBehaviour,
  type CollectionMethod,
  type NextAction,
} from "./source-result.js";

export {
  EVIDENCE_TIERS,
  ARTIFACT_KINDS,
  VERIFICATION_STATES,
  ATTESTATION_TYPES,
  GRADES,
  computeClaimGrade,
  weakestGrade,
  gradeAtLeast,
  compareGrade,
  type EvidenceTier,
  type ArtifactKind,
  type VerificationState,
  type AttestationType,
  type Grade,
  type ClaimGradeInput,
} from "./provenance.js";

export {
  READINESS_STATUSES,
  GATE_DECISIONS,
  isGoBlocking,
  aggregateReadiness,
  checkGateDecision,
  type ReadinessStatus,
  type GateDecisionValue,
  type GateDecisionRequest,
  type GateDecisionCheck,
  type GateDenyReason,
} from "./readiness.js";

export {
  canTransition,
  isTerminal,
  assertTransition,
  validateMachine,
  InvalidTransitionError,
  type StateMachine,
} from "./state-machine.js";

export * from "./machines.js";

export {
  PROTOCOL_PROPOSAL_TYPES,
  PROJECT_PROPOSAL_TYPES,
  FORBIDDEN_GOVERNANCE_TARGETS,
  checkProposalSpace,
  checkVoteEligibility,
  isForbiddenTarget,
  tallyVotes,
  type TallyInput,
  type TallyResult,
  type TallyOutcome,
  type GovernanceSpace,
  type ProtocolProposalType,
  type ProjectProposalType,
  type ProposalType,
  type SpaceCheck,
  type GovernanceDenyReason,
} from "./governance.js";

export {
  checkAttestationSignable,
  evaluateCredentialApplicability,
  canonicalAcceptanceBlockers,
  type AttestationSignRequest,
  type AttestationSignCheck,
  type AttestationDenyReason,
  type ConflictStatus,
  type CredentialCurrentStatus,
  type CredentialApplicability,
  type OngoingApplicability,
  type AcceptanceFacts,
  type AcceptanceBlocker,
} from "./attestation.js";

export {
  SENSITIVITY_LEVELS,
  PUBLIC_FIELD_ALLOWLIST,
  NEVER_PUBLIC_FIELDS,
  isPublicField,
  checkPublishable,
  checkRestrictedAction,
  type Sensitivity,
  type PublicField,
  type PublicationGuardInput,
  type PublicationCheck,
  type PublicationDenyReason,
  type DisclosureRestriction,
  type RestrictionCheck,
} from "./disclosure.js";

export {
  ADAPTER_STATES,
  adapterStateReason,
  checkAdapterAvailable,
  connectionStateToAdapterState,
  toReceiptInput,
  validateProfile,
  type AdapterState,
  type AdapterDescriptor,
  type AdapterAvailability,
  type AdapterOutcome,
  type AdapterInvocation,
  type JurisdictionProfile,
  type ProfileIssue,
} from "./adapter.js";

export {
  admitToStorage,
  storageTierFor,
  type StorageAdmission,
  type StorageTier,
} from "./storage-tier.js";

export {
  checkChannelReady,
  checkSecondReview,
  classifyBulkExport,
  classifySignedDocument,
  detectSchemaDrift,
  requiresSecondReview,
  type SchemaDrift,
  type SecondReviewCheck,
} from "./channels.js";

export {
  OFFERING_PRECONDITIONS,
  OFFERING_ABSENCE_COPY,
  OFFERING_NOT_MEANING,
  checkOfferingGate,
  type OfferingPreconditionKey,
  type PreconditionStatus,
  type OfferingGateDecision,
} from "./offering-gate.js";
