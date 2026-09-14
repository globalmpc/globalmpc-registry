import { z } from "zod";
import {
  ATTESTATION_TYPES,
  GATE_DECISIONS,
  GRADES,
  READINESS_STATUSES,
  SOURCE_RESULTS,
} from "@mpc/domain";
import { hex32, isoDateTime, safetyFields, sourceStatusView, walletAddress } from "./common.js";

/** Project — 04 §4.2. */
export const projectSummary = z.object({
  id: z.string(),
  projectKey: z.string(),
  name: z.string(),
  hostCountryIso3: z.string().length(3),
  minerals: z.array(z.string()),
  referenceStatus: z.enum(["none", "official_reference"]),
  lifecycleState: z.enum([
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
  ]),
  readinessSummary: z.enum(READINESS_STATUSES).nullable(),
  version: z.number().int().positive(),
  updatedAt: isoDateTime,
});

export const createProjectRequest = z.object({
  projectKey: z.string().min(1).max(64),
  name: z.string().min(1),
  hostCountryIso3: z.string().length(3),
  minerals: z.array(z.string()).default([]),
  ownerOrganizationId: z.string(),
});

/**
 * Unconfirmed items — 04 §4.2.
 * Tracked as four states plus an evidence reference, not as nullable text.
 */
export const projectFact = z.object({
  factKey: z.string(),
  status: z.enum(["confirmed", "pending", "rejected", "not_applicable"]),
  evidenceRef: z.string().nullable(),
  asOf: z.string().nullable(),
  note: z.string().nullable(),
});

/** Source Receipt — 05 §5.12. */
export const sourceReceipt = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    connectionId: z.string(),
    authorityId: z.string(),
    rawHash: hex32,
    queryBasis: z.record(z.unknown()),
    endpointOrDocumentRef: z.string(),
    authenticationMethod: z.string(),
    termsLicense: z.string(),
    commercialReuse: z.enum(["confirmed", "unconfirmed", "prohibited"]),
    receivedAt: isoDateTime,
    effectiveAt: isoDateTime.nullable(),
    correlationId: z.string(),
  })
  .merge(sourceStatusView);

/** Claim — numbers are a decimal string + unit + as-of date (ADR-T07). */
export const claim = z.object({
  id: z.string(),
  projectId: z.string(),
  claimType: z.string(),
  valueText: z.string(),
  unit: z.string().nullable(),
  asOf: z.string().nullable(),
  sourceCoordinate: z.record(z.unknown()),
  evidenceTier: z.enum(["P1", "P2", "P3", "P4", "P5"]).nullable(),
  verificationState: z.enum([
    "unreviewed",
    "machine_checked",
    "analyst_checked",
    "independently_assured",
    "rejected",
  ]),
  grade: z.enum(GRADES),
  /** Source Receipt this value came from. `null` means no evidence and is not hidden. */
  sourceReceiptId: z.string().nullable(),
  /** Whether the evidence has been shaken — AC-21. Does not mean it was never reviewed. */
  stale: z.boolean(),
  staleSince: z.string().nullable(),
  staleReason: z.string().nullable(),
  version: z.number().int().positive(),
});

/**
 * Anchor batch status — 08 §8.9.
 *
 * Exposes `confirmationState` unprocessed. Collapsing it into "done/in progress"
 * in the UI erases the difference between `included` and `confirmed` — that
 * difference is the point of this record.
 */
export const anchorBatchStatus = z.object({
  id: z.string(),
  batchId: hex32,
  root: hex32,
  manifestHash: hex32,
  recordCount: z.number().int().positive(),
  createdAt: isoDateTime,
  chainId: z.number().int().positive(),
  confirmationState: z.string(),
  transactionHash: z.string().nullable(),
  blockNumber: z.string().nullable(),
  confirmations: z.number().int(),
  attempts: z.number().int(),
  /** Last failure reason. Needed to decide the next action. */
  lastError: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  confirmedAt: isoDateTime.nullable(),
  /** Whether this batch was ever reorged. The fact persists even after reconfirmation. */
  reorgCount: z.number().int(),
  /** Whether a human needs to look. Does not clear automatically. */
  needsAttention: z.boolean(),
  /**
   * Safe proposal details. Present only on chains where EOA submission is blocked.
   *
   * **A proposal existing does not mean it was submitted.** People collect
   * signatures and execute in the Safe; until then nothing is on chain.
   */
  proposal: z
    .object({
      safeAddress: walletAddress,
      calldataHash: hex32,
      state: z.string(),
      createdAt: isoDateTime,
    })
    .nullable(),
});

/**
 * Upload — 05 §5.2, 06 §6.7.
 *
 * **An upload is not evidence.** It is promoted only after passing through
 * quarantine and scanning clean. Showing both states on one screen with the same
 * wording would make unscanned files read as material for review.
 *
 * `originalFilename` is restricted. It is included in responses but can never
 * reach a public projection.
 */
export const objectUpload = z.object({
  id: z.string(),
  projectId: z.string(),
  contentHash: hex32,
  byteSize: z.number().int().positive(),
  contentType: z.string(),
  originalFilename: z.string().nullable(),
  sensitivity: z.string(),
  state: z.enum([
    "received",
    "quarantined",
    "scanned_clean",
    "scanned_infected",
    "promoted",
    "rejected",
  ]),
  uploadedAt: isoDateTime,
  scannedAt: isoDateTime.nullable(),
  promotedArtifactId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  /** What can be done next from this state. Not left to guesswork. */
  nextActions: z.array(z.string()),
  version: z.number().int().positive(),
});

/** Short-lived download URL. No permanent public URL is created (06 §6.7). */
/**
 * Scanner liveness.
 *
 * Attached to the upload list. `promote` transitions only from `scanned_clean`,
 * so in a deployment without a scan worker uploads stay `quarantined` forever,
 * and **that stall looks like waiting, not an error.** The list states the
 * difference itself.
 */
export const scannerStatus = z.object({
  state: z.enum(["running", "stale", "never_seen", "unknown"]),
  secondsSinceHeartbeat: z.number().int().nonnegative().nullable(),
  detail: z.string(),
});

export const uploadDownloadLink = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int().positive(),
  /** What this link does not bypass. Its recipient does not go through authorization again. */
  warning: z.string(),
});

/**
 * Audit event — 02 §2.6.
 *
 * `audit.events` is append-only; even a superuser cannot modify it. Without a
 * read path, operations cannot use that guarantee — checking who did what would
 * require connecting to the DB directly, which itself undermines trust in the
 * audit.
 *
 * **The payload is not exposed.** PII is not supposed to go into detail, but if
 * that promise breaks, this screen would be the first leak path.
 */
export const auditEvent = z.object({
  id: z.string(),
  occurredAt: isoDateTime,
  command: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  actorWallet: walletAddress.nullable(),
  effectiveRole: z.string().nullable(),
  beforeVersion: z.number().int().nullable(),
  afterVersion: z.number().int().nullable(),
  reason: z.string().nullable(),
  correlationId: z.string(),
  projectId: z.string().nullable(),
});

/**
 * Event publication backlog — 07 §7.5.
 *
 * The outbox is at-least-once. When it backs up, events are not lost but
 * **delayed** — that distinction determines the response.
 */
export const outboxBacklog = z.object({
  pending: z.number().int(),
  oldestPendingAt: isoDateTime.nullable(),
  /** Age in seconds of the oldest unpublished event. Null means no backlog. */
  oldestPendingAgeSeconds: z.number().int().nullable(),
  publishedLastHour: z.number().int(),
  byEventType: z.array(z.object({ eventType: z.string(), pending: z.number().int() })),
});

/**
 * Verification Case summary — 04 §4.4.
 *
 * Reviewers must be able to find the cases assigned to them. The person who
 * creates an assignment differs from the one who signs (02 §2.4), so passing it
 * only through UI state would leave reviewers no way to reach their assignments.
 */
export const verificationCaseSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  assignmentId: z.string(),
  schemaId: z.string(),
  state: z.string(),
  evidenceSnapshotHash: hex32,
  claimIds: z.array(z.string()),
  /** Reviewer assigned to this case. The UI checks whether the logged-in user is that reviewer. */
  reviewerSubjectId: z.string(),
  assignedAt: isoDateTime,
  /** Incremented on every state transition. If-Match checks this value. */
  version: z.number().int().positive(),
  /** Past states and reasons. The path persists even after going back. */
  transitions: z.array(
    z.object({
      fromState: z.string(),
      toState: z.string(),
      reason: z.string(),
      occurredAt: isoDateTime,
    }),
  ),
});

/**
 * Case state transition request — 04 §4.4.
 *
 * Changing state records a fact, so it cannot happen without a reason — without
 * what `changes_requested` needs fixed or why `cancelled` stopped, the next
 * person has nothing to judge by.
 */
export const transitionCaseRequest = z.object({
  toState: z.enum([
    "in_review",
    "changes_requested",
    "declined",
    "cancelled",
  ]),
  reason: z.string().min(1, "The reason for the state change cannot be empty"),
});

/**
 * Attestation dispute — 04 §4.2.
 *
 * **The signature is never erased.** The judgment at signing time stays and a new
 * fact, `disputed`, is added. Deleting the signature would lose "who judged what,
 * and when".
 */
export const disputeAttestationRequest = z.object({
  reasonCode: z.string().min(1),
  detail: z.string().min(1, "The dispute reason cannot be empty"),
});

/** A raised dispute. Not deleted even when resolved. */
export const attestationDispute = z.object({
  id: z.string(),
  attestationId: z.string(),
  reasonCode: z.string(),
  detail: z.string(),
  raisedAt: isoDateTime,
  resolvedAt: isoDateTime.nullable(),
  /** `upheld` or `dismissed`. Null while unresolved. */
  outcome: z.string().nullable(),
  resolution: z.string().nullable(),
});

/**
 * Dispute resolution request — 04 §4.2.
 *
 * `upheld` means the dispute was right; `dismissed` means the review stands.
 * Either way **the dispute record itself remains** — deleting it on resolution
 * would erase the fact that "a problem was once raised".
 */
export const resolveDisputeRequest = z.object({
  outcome: z.enum(["upheld", "dismissed"]),
  resolution: z.string().min(1, "The resolution rationale cannot be empty"),
});

/** Verification Attestation — 04 §4.2. */
export const verificationAttestation = z.object({
  id: z.string(),
  caseId: z.string(),
  assignmentId: z.string(),
  attestationType: z.enum(ATTESTATION_TYPES),
  claimScope: z.array(z.string()).min(1),
  evidenceSnapshotHash: hex32,
  findings: z.array(z.record(z.unknown())),
  citations: z.array(z.record(z.unknown())),
  /** AC-01: empty strings are not allowed. */
  limitations: z.string().min(1),
  credentialStatusSnapshot: z.object({
    credentialId: z.string(),
    statusAtSigning: z.string(),
    validAtAttestationTime: z.boolean(),
  }),
  /** AC-17: current status is shown separately. The past is not overwritten. */
  credentialCurrentStatus: z.enum(["valid", "expired", "revoked", "suspended", "unknown"]),
  ongoingApplicability: z.enum(["applicable", "needs_review", "not_applicable"]),
  methodVersion: z.string(),
  policyVersion: z.string(),
  payloadHash: hex32,
  signature: z.string(),
  signerWalletAddress: walletAddress,
  signedAt: isoDateTime,
  state: z.enum([
    "draft",
    "signed",
    "active",
    "stale_candidate",
    "superseded",
    "revoked",
    "disputed",
  ]),
  supersedesId: z.string().nullable(),
});

export const createAttestationRequest = z.object({
  caseId: z.string(),
  assignmentId: z.string(),
  attestationType: z.enum(ATTESTATION_TYPES),
  claimScope: z.array(z.string()).min(1),
  findings: z.array(z.record(z.unknown())).default([]),
  citations: z.array(z.record(z.unknown())).default([]),
  limitations: z.string().min(1, "limitations cannot be empty"),
});

/** Readiness Assessment — 05 §5.4. */
export const requirementResult = z.object({
  requirementId: z.string(),
  label: z.string(),
  status: z.enum(READINESS_STATUSES),
  applicable: z.boolean(),
  reasonCode: z.string(),
  missing: z.array(z.string()),
});

export const readinessAssessment = z
  .object({
    id: z.string(),
    projectId: z.string(),
    gateId: z.string(),
    policySetId: z.string(),
    ruleSetVersion: z.string(),
    inputSnapshotHash: hex32,
    evaluatedAsOf: isoDateTime,
    status: z.enum(READINESS_STATUSES),
    requirementResults: z.array(requirementResult),
    canonicalResultHash: hex32,
    generatedAt: isoDateTime,
  })
  .merge(safetyFields.pick({ authority: true, ruleVersion: true, limitations: true, disclaimerCodes: true }));

/** Gate Decision — made by a human. A record separate from readiness (§4.2). */
export const gateDecision = z.object({
  id: z.string(),
  projectId: z.string(),
  gateId: z.string(),
  decision: z.enum(GATE_DECISIONS),
  inputAssessmentId: z.string(),
  evidenceSnapshotHash: hex32,
  decisionAuthority: z.string(),
  decisionMakerSubjectId: z.string(),
  rationale: z.string().min(1),
  assumptions: z.array(z.string()),
  conditions: z.array(z.string()),
  signedAt: isoDateTime,
});

export const createGateDecisionRequest = z.object({
  gateId: z.string(),
  decision: z.enum(GATE_DECISIONS),
  inputAssessmentId: z.string(),
  rationale: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  conditions: z.array(z.string()).default([]),
});

/**
 * Asset/Offering activation gate — OD-07.
 *
 * **There are no trading fields.** Names like `price`, `amount`, or `subscribe`
 * are absent from this schema by design — the response shape itself states
 * "what exists".
 *
 * Returns only the remaining conditions and their owners. The UI shows those
 * instead of an empty slot.
 */
export const offeringGateStatus = z.object({
  projectId: z.string(),
  activatable: z.boolean(),
  missing: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      why: z.string(),
      owner: z.string(),
    }),
  ),
  /** Items marked satisfied without evidence. More dangerous than missing ones. */
  unsupported: z.array(z.string()),
  /** States in words that the feature does not exist. */
  absenceNotice: z.string(),
  notMeaning: z.string(),
});

/**
 * Evidence signal — AC-21.
 *
 * Leaves the target unchanged and records only that "the evidence this output
 * stood on has been shaken". **An open signal means review is needed, not that
 * the record is wrong.**
 */
export const evidenceStaleSignal = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  targetType: z.enum(["compliance_assessment", "registry_entry_version"]),
  targetId: z.string(),
  originAttestationId: z.string().nullable(),
  reason: z.string(),
  detectedAt: z.string(),
  resolution: z.enum(["open", "superseded", "revoked", "dismissed"]),
  resolvedAt: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  /** What can be done with this signal. The server decides so the UI does not guess. */
  nextActions: z.array(z.string()),
});

/**
 * Signal resolution — AC-21.
 *
 * Taking down a public record changes what the world sees. That decision is not
 * automated, so a reason is always required.
 */
export const resolveStaleSignalRequest = z.object({
  resolution: z.enum(["superseded", "revoked", "dismissed"]),
  note: z.string().min(1),
});

/**
 * Second review — AC-29.
 *
 * A manual check has no API response and no signature; one person's statement is
 * the only evidence. It is confirmed only when another person looks up the same
 * registry and verifies it.
 */
export const secondReviewRequest = z.object({
  /** What the second lookup showed. Saying "same" alone is not a review. */
  observation: z.string().min(1),
  confirmed: z.boolean(),
});

/**
 * Source lookup request — 05 §5.12, OD-42.
 *
 * Does not accept `result`. The source decides what came back, not the caller.
 * The request states only "what the lookup is based on".
 */
export const sourceCollectRequest = z.object({
  projectId: z.string().uuid(),
  /** Lookup criteria. Kept verbatim in the receipt as the basis for reproduction. */
  queryBasis: z.record(z.string(), z.string()),
});

/**
 * Source lookup result — 05 §5.12.
 *
 * **Failures create receipts too.** "No record" (404) and "source outage" (503)
 * are both facts; unrecorded, the next person repeats the same lookup.
 */
export const sourceCollectResult = z.object({
  receiptId: z.string(),
  connectionId: z.string(),
  authorityId: z.string(),
  /** One of the 12 results. Only `confirmed_from_source` counts as confirmed. */
  result: z.string(),
  /** Whether it succeeded. The server decides so the UI does not reinterpret `result`. */
  confirmed: z.boolean(),
  /** Effective date stated by the source. Differs from the lookup time. */
  effectiveAt: z.string().nullable(),
  /** Always includes the limitations the authority declared. */
  limitations: z.array(z.string()),
  detail: z.string().nullable(),
});

/**
 * Authority registration — 02 §2.8, 05 §5.11, REQ-DAPP-043.
 *
 * **`doesNotProve` is required and cannot be empty.** No authority is without
 * limitations. If optional, it would be left blank under time pressure, and
 * readers of the receipt would mistake it for full confirmation.
 *
 * Does not accept `state`. Registration always starts at `proposed`; if the
 * registrant could set approval state, the §2.8 separation would collapse.
 */
export const authorityRegisterRequest = z.object({
  name: z.string().min(1),
  jurisdiction: z.string().length(3),
  proves: z.array(z.string().min(1)).min(1),
  doesNotProve: z.array(z.string().min(1)).min(1),
  recognizedScope: z.array(z.string().min(1)).min(1),
  verificationMethod: z.string().min(1),
  publicDisclosureLevel: z.enum(["public", "restricted", "confidential", "pii", "whistleblower"]),
  validFrom: z.string(),
  validUntil: z.string().nullable().optional(),
  /** Why this authority is proposed as a candidate. Becomes the first history entry. */
  reason: z.string().min(1),
});

/** Update. Jurisdiction cannot change — a different jurisdiction is a different authority. */
export const authorityUpdateRequest = z.object({
  name: z.string().min(1).optional(),
  proves: z.array(z.string().min(1)).min(1).optional(),
  doesNotProve: z.array(z.string().min(1)).min(1).optional(),
  recognizedScope: z.array(z.string().min(1)).min(1).optional(),
  verificationMethod: z.string().min(1).optional(),
  validUntil: z.string().nullable().optional(),
  reason: z.string().min(1),
});

/**
 * State transition.
 *
 * The registrant cannot approve (02 §2.8: no operator-only `accepted`
 * transition). The server enforces this — hiding a button in the UI cannot.
 */
export const authorityStateRequest = z.object({
  state: z.enum(["under_review", "accepted", "suspended", "expired", "revoked", "superseded"]),
  reason: z.string().min(1),
});

/** One authority history entry. Records what the authority claimed to prove at the time. */
export const authorityVersionEntry = z.object({
  version: z.number().int(),
  name: z.string(),
  proves: z.array(z.string()),
  doesNotProve: z.array(z.string()),
  recognizedScope: z.array(z.string()),
  verificationMethod: z.string(),
  state: z.string(),
  stateReason: z.string().nullable(),
  changeReason: z.string(),
  recordedAt: z.string(),
});

/**
 * Connection configuration — 02 §2.8.
 *
 * `state` can be set to `active` directly, but the DB rejects it unless the
 * authority is `accepted`. §2.8 requires that **API success cannot be turned
 * into authority approval**.
 *
 * Credential values are not accepted, only `secretReference` — a value passing
 * through the API would end up in request logs and error reports.
 */
export const connectionConfigureRequest = z.object({
  connectionKey: z.string().min(1).optional(),
  collectionMethod: z.enum([
    "authenticated_api",
    "official_bulk_export",
    "verifiable_signed_document",
    "manual_official_registry_confirmation",
  ]).optional(),
  accessBasis: z.string().min(1).optional(),
  secretReference: z.string().min(1).nullable().optional(),
  state: z.enum([
    "planned",
    "feasibility_checked",
    "access_confirmed",
    "tested",
    "active",
    "degraded",
    "disabled",
  ]).optional(),
  endpoint: z.string().url().nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  effectiveAtField: z.string().nullable().optional(),
  authenticationMethod: z.string().optional(),
  adapterVersion: z.string().optional(),
  sourceSchemaVersion: z.string().optional(),
  termsLicense: z.string().optional(),
  commercialReuse: z.enum(["confirmed", "unconfirmed", "prohibited"]).optional(),
  disclosurePermission: z
    .enum(["public", "restricted", "confidential", "pii", "whistleblower"])
    .optional(),
  reason: z.string().min(1),
});

export const sourceConnectionEntry = z.object({
  id: z.string(),
  authorityId: z.string(),
  connectionKey: z.string(),
  collectionMethod: z.string(),
  state: z.string(),
  /** Call target. Not secret, so it is shown — credentials are not here. */
  endpoint: z.string().nullable(),
  /** Whether a credential is configured. The value is never returned. */
  hasSecret: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  version: z.number().int(),
});

/**
 * Authority Registry entry — 05 §5.11, OD-42·OD-43.
 *
 * Always returns `doesNotProve` too. Showing only what an authority proves makes
 * readers mistake it for full confirmation.
 *
 * Entries whose `adapterState` is not `active` stay in the list — dropping them
 * hides "why is this authority missing", and marking them active promises a
 * connection that does not exist.
 */
export const authorityEntry = z.object({
  id: z.string(),
  name: z.string(),
  jurisdiction: z.string(),
  proves: z.array(z.string()),
  doesNotProve: z.array(z.string()).min(1),
  recognizedScope: z.array(z.string()),
  verificationMethod: z.string(),
  state: z.string(),
  validFrom: z.string(),
  validUntil: z.string().nullable(),
  /** Connection status. Only `active` is actually called. */
  adapterState: z.enum(["active", "manual", "pending_access", "blocked", "none"]),
  adapterStateReason: z.string().nullable(),
  connectionKey: z.string().nullable(),
  /** Whether this source can be called now. If not, says what to do next. */
  callable: z.boolean(),
  nextAction: z.string().nullable(),
});

/** Jurisdiction Profile summary — connection status per jurisdiction. */
export const jurisdictionProfileView = z.object({
  jurisdiction: z.string(),
  authorities: z.array(authorityEntry),
  activeCount: z.number().int(),
  manualCount: z.number().int(),
  pendingCount: z.number().int(),
  /** What this profile does not promise. Does not overstate unconfirmed integrations (R5 gate). */
  limitations: z.array(z.string()),
});

/**
 * Governance proposal — 04 §4.5, OD-06.
 *
 * Includes the quorum and pass threshold in the response. Values are fixed at
 * proposal time, so later rule changes cannot flip the outcome (non-retroactive).
 */
export const governanceProposal = z.object({
  id: z.string(),
  space: z.enum(["protocol", "project"]),
  projectId: z.string().nullable(),
  proposalType: z.string(),
  title: z.string(),
  rationale: z.string(),
  state: z.string(),
  proposerSubjectId: z.string(),
  quorum: z.object({ numerator: z.number().int(), denominator: z.number().int() }),
  threshold: z.object({ numerator: z.number().int(), denominator: z.number().int() }),
  votingOpensAt: isoDateTime.nullable(),
  votingClosesAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  version: z.number().int().positive(),
  /** Current tally. Weights are decimal strings (ADR-T07). */
  tally: z.object({
    forWeight: z.string(),
    againstWeight: z.string(),
    abstainWeight: z.string(),
    participatedWeight: z.string(),
    quorumMet: z.boolean(),
    thresholdMet: z.boolean(),
    /** Outcome if voting closed now. Not final. */
    provisionalOutcome: z.string(),
    reason: z.string(),
  }),
  /** Transition history. No quorum and cancellation only look alike in outcome. */
  transitions: z.array(
    z.object({
      fromState: z.string(),
      toState: z.string(),
      reason: z.string(),
      occurredAt: isoDateTime,
    }),
  ),
  /**
   * Where the weight came from.
   *
   * `manual` means the voter specified the value — the result must not be read
   * as on-chain evidence.
   */
  weightSource: z.enum(["onchain_snapshot", "manual"]),
  /** Snapshot block. Null when `manual`. */
  snapshotBlock: z.string().nullable(),
  /**
   * Quorum denominator — the total weight eligible to vote.
   *
   * Not the sum of votes cast; otherwise `participation × D >= participation × N`
   * is always true and `no_quorum` is structurally impossible (09 §9.6). Fixed
   * when voting opens; null before then.
   */
  eligibleWeight: z.string().nullable(),
  /**
   * Where the denominator came from.
   *
   * `manual` means a person specified the value — the result must not be read as
   * on-chain evidence.
   */
  eligibleWeightSource: z.enum(["onchain_total_supply", "manual"]).nullable(),
  /** What this proposal cannot create. A vote does not create off-chain facts. */
  limitations: z.array(z.string()),
});

export const createProposalRequest = z.object({
  space: z.enum(["protocol", "project"]),
  projectId: z.string().uuid().nullable().default(null),
  proposalType: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1, "The proposal rationale cannot be empty"),
  quorumNumerator: z.number().int().positive().default(1),
  quorumDenominator: z.number().int().positive().default(4),
  thresholdNumerator: z.number().int().positive().default(1),
  thresholdDenominator: z.number().int().positive().default(2),
  /**
   * Candidate quorum denominator.
   *
   * Ignored for proposals whose on-chain total supply is readable. Proposals
   * without it need this value before voting can open.
   */
  eligibleWeight: z
    .string()
    .regex(/^[1-9]\d*$/, "The quorum denominator must be an integer string of 1 or more")
    .nullable()
    .default(null),
});

export const castVoteRequest = z.object({
  choice: z.enum(["for", "against", "abstain"]),
  /**
   * Vote weight, as a decimal string — JSON numbers lose precision.
   *
   * **Ignored when an on-chain snapshot exists.** The server then uses the balance
   * at the snapshot, so this is optional. If required, clients would have to
   * invent a value that gets ignored and would read it as counted.
   */
  weight: z
    .string()
    .regex(/^\d+$/, "Weight must be a non-negative integer string")
    .optional(),
});

export const transitionProposalRequest = z.object({
  toState: z.enum([
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
    "cancelled",
  ]),
  reason: z.string().min(1, "The reason for the state change cannot be empty"),
});

/** Registry version — 05 §5.6. */
export const registryEntryVersion = z.object({
  id: z.string(),
  registryType: z.enum(["project", "verification", "asset"]),
  publicKey: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "published", "revoked", "superseded"]),
  contentHash: hex32.nullable(),
  policyVersion: z.string(),
  schemaVersion: z.string(),
  serializationVersion: z.literal("1"),
  publishedAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
  supersededById: z.string().nullable(),
});

/**
 * Public projection — only what passes the 05 §5.7 allowlist.
 *
 * `.strict()` matters. If undefined fields slipped into the response, the
 * allowlist would be meaningless (AC-22).
 */
export const publicProjection = z
  .object({
    stableId: z.string(),
    projectKey: z.string().optional(),
    projectName: z.string().optional(),
    hostCountry: z.string().optional(),
    mineral: z.array(z.string()).optional(),
    status: z.string(),
    version: z.string(),
    asOf: isoDateTime,
    sourceAge: z.string().nullable(),
    staleStatus: z.string(),
    claimSummary: z.array(z.record(z.string())).optional(),
    grade: z.enum(GRADES).optional(),
    limitations: z.array(z.string()),
    verificationScope: z.array(z.string()).optional(),
    authorityType: z.string().optional(),
    authorityScope: z.array(z.string()).optional(),
    collectionMethod: z.string().optional(),
    /** Defaults to a pseudonymous handle, not a natural person's name or registration number (AC-32). */
    reviewerPseudonymousHandle: z.string().optional(),
    reviewerOrganization: z.string().optional(),
    reviewerCredentialType: z.string().optional(),
    reviewerCredentialScope: z.array(z.string()).optional(),
    decisionAuthority: z.string().optional(),
    decisionType: z.string().optional(),
    decisionDate: z.string().optional(),
    anchorTransaction: z.string().nullable().optional(),
    anchorRoot: hex32.nullable().optional(),
    supersededBy: z.string().nullable().optional(),
    revokedAt: isoDateTime.nullable().optional(),
    disputeStatus: z.string().optional(),
    legalEffect: z.enum(["none", "counsel_required"]),
    disclaimerCodes: z.array(z.string()),
  })
  .strict();

/**
 * Inclusion proof — AC-23.
 *
 * The response itself states what `included: true` means. `proves` and
 * `doesNotProve` are returned together so clients cannot translate it into
 * "verified".
 */
export const inclusionProofResponse = z.object({
  entryVersionId: z.string(),
  leafHash: hex32,
  proof: z.array(hex32),
  root: hex32,
  batchId: hex32,
  chainId: z.number().int().positive(),
  transactionHash: hex32.nullable(),
  blockNumber: z.number().int().nonnegative().nullable(),
  confirmationState: z.enum([
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
  ]),
  included: z.boolean(),
  proves: z.array(z.string()).describe("What this proof confirms"),
  doesNotProve: z.array(z.string()).describe("What this proof does not confirm"),
  /**
   * Spec for rebuilding the leaf — decided 2026-09-09.
   *
   * All three are **non-identifying version strings**. They carry no subject or
   * source content — that is a separate decision. Without them, a verifier cannot
   * tell which spec to reconstruct with.
   *
   * Why `serializationVersion` is not `literal("1")`: bumping the spec changes the
   * value (CLAUDE.md). If the contract forced `"1"`, responses would violate the
   * contract on that day.
   */
  policyVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  serializationVersion: z.string().min(1),
});

export const PROOF_PROVES = [
  "The bytes of this public version are included in the anchor batch",
  "Those bytes have not changed since inclusion",
] as const;

export const PROOF_DOES_NOT_PROVE = [
  "Factual accuracy of the source content",
  "The reviewer's authority eligibility",
  "Legal effect or lawfulness of issuance",
  "Investment suitability or profitability",
  "Government approval or an MPC guarantee",
] as const;

export const sourceResultEnumValues = SOURCE_RESULTS;

/**
 * One public list row.
 *
 * The projection is nested under `projection`, not spread. Spreading would mix
 * list metadata (`publicKey`, `entryVersionId`) with projection fields on one
 * level, making it impossible to tell from the response alone whether "only
 * public-allowed fields went out". Nesting makes that a one-line check.
 */
export const publicRegistryListItem = z
  .object({
    publicKey: z.string(),
    entryVersionId: z.string(),
    version: z.string(),
    status: z.string(),
    publishedAt: isoDateTime.nullable(),
    revokedAt: isoDateTime.nullable(),
    supersededBy: z.string().nullable(),
    projection: publicProjection,
  })
  .strict();

/**
 * Public list — sorting and pagination are fixed by the contract.
 *
 * Why `nextCursor` is an opaque string: once clients start assembling sort keys,
 * the sort can never change. The only way to request the next page is to send
 * this value back unchanged.
 */
export const publicRegistryList = z.object({
  items: z.array(publicRegistryListItem),
  nextCursor: z.string().nullable(),
  /** Sort order is fixed. Clients cannot choose it; the response states what it is sorted by. */
  sort: z.literal("publishedAt:desc,entryId:desc"),
});

/** Public list query — 07 §7.1. Parameters not listed here are rejected, not ignored. */
export const publicRegistryListQuery = z
  .object({
    q: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["published", "revoked", "superseded"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * Public protocol proposal.
 *
 * Does not include the voter list. The tally is the basis for the outcome; the
 * list is not, and individual voters are subjects that lead to natural-person
 * identifiers (AC-32).
 *
 * Weights are decimal strings. `NUMERIC(78,0)` does not fit in a JSON number
 * (ADR-T07 — moving big integers into numbers silently rounds them).
 */
export const publicProposal = z
  .object({
    id: z.string(),
    proposalType: z.string(),
    title: z.string(),
    rationale: z.string(),
    state: z.string(),
    quorum: z.object({ numerator: z.number().int(), denominator: z.number().int() }),
    threshold: z.object({ numerator: z.number().int(), denominator: z.number().int() }),
    votingOpensAt: isoDateTime.nullable(),
    votingClosesAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    tally: z.object({
      for: z.string(),
      against: z.string(),
      abstain: z.string(),
      voterCount: z.number().int().nonnegative(),
    }),
  })
  .strict();

export const publicProposalList = z.object({
  items: z.array(publicProposal),
  nextCursor: z.string().nullable(),
  sort: z.literal("createdAt:desc,id:desc"),
});

/** One proposal and its transition history. By state alone, no quorum and cancellation look the same. */
export const publicProposalDetail = publicProposal.extend({
  transitions: z.array(
    z.object({
      fromState: z.string(),
      toState: z.string(),
      reason: z.string(),
      occurredAt: isoDateTime,
      tallySnapshot: z.record(z.unknown()).nullable(),
    }),
  ),
});

/**
 * Public history events.
 *
 * Nothing new is disclosed here. `revoked` and `superseded` public versions are
 * already returned by detail lookups — the only difference is ordering by "what
 * happened when" instead of "which record".
 */
/**
 * One public history event.
 *
 * **Granularity is "it happened + when + which record"** (decision, 2026-09-09).
 * Content (reason, legal basis, details) and parties (actor, requesting
 * authority, raiser) are excluded. Widening later is possible but narrowing is
 * not (05 §5.7), so it starts narrow.
 *
 * `registryVersion` exists only for corrections and revocations. suspension,
 * pause, and dispute are transition, restriction, and dispute rows rather than
 * registry versions, so they have no version — `null` says "this kind has no
 * such value".
 */
export const publicDisclosureEvent = z
  .object({
    eventId: z.string(),
    eventKind: z.enum([
      "revocation",
      "source_correction",
      "suspension",
      "pause",
      "dispute",
    ]),
    occurredAt: isoDateTime,
    registryType: z.enum(["project", "verification", "asset"]),
    publicKey: z.string(),
    /** Present only for corrections and revocations. Null otherwise. */
    registryVersion: z
      .object({
        entryVersionId: z.string(),
        version: z.string(),
        supersededBy: z.string().nullable(),
        projection: publicProjection,
      })
      .strict()
      .nullable(),
    /** Present only for suspension. Excludes reason and actor. */
    lifecycle: z
      .object({ fromState: z.string(), toState: z.string() })
      .strict()
      .nullable(),
    /** When the pause or dispute ended. Null while still open. */
    resolvedAt: isoDateTime.nullable(),
  })
  .strict();

export const publicDisclosureList = z.object({
  items: z.array(publicDisclosureEvent),
  nextCursor: z.string().nullable(),
  sort: z.literal("occurredAt:desc,eventId:desc"),
  /**
   * Event kinds this list **does not cover**.
   *
   * Without distinguishing an empty list from "that kind never appears here",
   * users read it as "nothing like that happened". The response states its own
   * scope.
   */
  notCovered: z.array(z.object({ kind: z.string(), reason: z.string() })),
});

/** Cursor-only public list query. No `q` because a timeline is not a search target. */
export const publicCursorQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * Unified public search.
 *
 * A 0x-prefixed 32-byte hex is treated as a hash (transaction, Merkle root, leaf,
 * batch); anything else as an exact registry key match plus name, country, and
 * mineral search. Wallet addresses are not accepted — public records carry no
 * submitter address, so the question cannot be answered.
 */
export const publicSearchQuery = z
  .object({
    q: z.string().trim().min(1).max(120),
  })
  .strict();

export const publicSearchResult = z.object({
  query: z.string(),
  chainId: z.number().int().positive(),
  kind: z.enum(["hash", "text"]),
  matches: z.array(
    z.object({
      matchedOn: z.enum([
        "transaction_hash",
        "merkle_root",
        "leaf_hash",
        "batch_id",
        "public_key",
        "text",
      ]),
      registryType: z.enum(["project", "verification", "asset"]),
      publicKey: z.string(),
      entryVersionId: z.string(),
      version: z.string(),
      status: z.string(),
      merkleRoot: z.string().nullable(),
      transactionHash: z.string().nullable(),
    }),
  ),
  requestId: z.string(),
  asOf: isoDateTime,
});

/**
 * My activity.
 *
 * Audit records of mutations made by the subject bound to this wallet. **Visible
 * only to that subject.** No role is needed because these are one's own actions,
 * not someone else's records. Request IP and detail are omitted — command and
 * resource are enough to show what was done.
 */
export const myActivityQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

export const myActivity = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      occurredAt: isoDateTime,
      command: z.string(),
      resourceType: z.string(),
      resourceId: z.string().nullable(),
      projectId: z.string().nullable(),
      effectiveRole: z.string().nullable(),
      reason: z.string().nullable(),
      signatureOrTx: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  requestId: z.string(),
  asOf: isoDateTime,
});

// --- Platform administration -------------------------------------------

/**
 * One subject as seen by the admin screen.
 *
 * Returns wallets and roles **together**. Queried separately, the state "has
 * roles but every bound wallet is disabled" would be split across two screens
 * and go unnoticed — and that state is exactly an account that cannot log in.
 */
export const adminSubject = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Person or system identity. Credentials are managed differently. */
  kind: z.enum(["person", "service"]),
  wallets: z.array(
    z.object({
      id: z.string(),
      walletAddress: walletAddress,
      chainId: z.number().int(),
      assuranceLevel: z.enum(["wallet_only", "identity_bound", "high_assurance"]),
      boundAt: isoDateTime.nullable(),
      disabledAt: isoDateTime.nullable(),
      version: z.number().int().positive(),
    }),
  ),
  roles: z.array(
    z.object({
      id: z.string(),
      role: z.string(),
      projectId: z.string().nullable(),
      grantedAt: isoDateTime,
      revokedAt: isoDateTime.nullable(),
    }),
  ),
  /** Whether no wallet can log in. The UI must say so first. */
  locked: z.boolean(),
});

export const createSubjectRequest = z.object({
  displayName: z.string().min(1).max(200),
  /** Defaults to a person. `service` is only for system identities such as the scan worker. */
  kind: z.enum(["person", "service"]).default("person"),
});

export const bindWalletRequest = z.object({
  walletAddress: walletAddress,
  chainId: z.number().int().refine((value) => value === 56 || value === 97),
  assuranceLevel: z.enum(["wallet_only", "identity_bound", "high_assurance"]),
});

/**
 * Wallet disable — AC-27.
 *
 * Requires a reason code. Loss, compromise, rotation, and offboarding have the
 * same effect but **differ in how past signatures should be read.** Free text
 * alone would not preserve that distinction.
 */
export const disableWalletRequest = z.object({
  reasonCode: z.enum(["key_lost", "key_compromised", "rotation", "offboarding"]),
  detail: z.string().min(1).max(1000),
});

export const roleGrantRequest = z.object({
  id: z.string(),
  subjectId: z.string(),
  subjectName: z.string(),
  role: z.string(),
  projectId: z.string().nullable(),
  reason: z.string(),
  requestedBySubjectId: z.string(),
  requestedAt: isoDateTime,
  state: z.enum(["pending", "approved", "rejected", "withdrawn"]),
  decidedBySubjectId: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionReason: z.string().nullable(),
  version: z.number().int().positive(),
});

export const createRoleGrantRequest = z.object({
  subjectId: z.string().uuid(),
  role: z.string().min(1),
  projectId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  reason: z.string().min(1).max(1000),
});

/** Approve or reject. Rejected if the decider is the proposer — the DB blocks this too. */
export const decideRoleGrantRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1).max(1000),
});

// --- Workspace aggregates ---------------------------------------

/**
 * One registry publication status row.
 *
 * Previously, publication status was visible only by opening a project.
 * Answering "what has this tenant published" then meant opening projects one by
 * one, which is not an answer.
 */
export const registryEntrySummary = z.object({
  entryId: z.string(),
  registryType: z.enum(["project", "verification", "asset"]),
  publicKey: z.string(),
  projectId: z.string().nullable(),
  latestVersion: z.number().int(),
  status: z.enum(["draft", "published", "revoked", "superseded"]),
  publishedAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
  /** Whether this version is in an anchor batch. Publishing and anchoring are separate events. */
  anchored: z.boolean(),
});

/**
 * My Work.
 *
 * Splits the three **by meaning.** Mixed into one list, "what I must do" and
 * "what I am waiting on" look alike, yet their next actions are opposite.
 */
export const myWork = z.object({
  /** Reviews assigned to me. They finish only when I act. */
  assignedToMe: z.array(
    z.object({
      caseId: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      state: z.string(),
      assignedAt: isoDateTime,
      conflictStatus: z.string(),
    }),
  ),
  /** Things I started that await someone else's decision. Nothing for me to do. */
  waitingOnOthers: z.array(
    z.object({
      kind: z.literal("role_grant"),
      id: z.string(),
      summary: z.string(),
      since: isoDateTime,
    }),
  ),
  /** Open items assigned to no one. Left alone, nobody notices. */
  unassigned: z.array(
    z.object({
      kind: z.enum(["stale_signal", "role_grant_decision"]),
      id: z.string(),
      projectId: z.string().nullable(),
      summary: z.string(),
      since: isoDateTime,
    }),
  ),
});

/**
 * Notification.
 *
 * `read` is not a property of the notification itself but **a value that depends
 * on the reader**. A notification sent to a role is seen by several people; if
 * one person reading it cleared it for everyone, nobody would look again when
 * that person did not act on it.
 */
export const notification = z
  .object({
    id: z.string(),
    kind: z.enum(["review_assigned", "readiness_gap", "evidence_stale", "registry_revoked"]),
    /** Sent to me, or to a role I hold. */
    audience: z.enum(["you", "role"]),
    audienceRole: z.string().nullable(),
    projectId: z.string().nullable(),
    summary: z.string(),
    /** A notification with nowhere to go forces a search. */
    link: z.string(),
    occurredAt: isoDateTime,
    read: z.boolean(),
  })
  .strict();

/**
 * Project lifecycle transition — 04 §4.3.
 *
 * `reason` is required. A transition without a reason leaves nothing to judge by
 * later.
 */
export const projectLifecycleTransitionRequest = z.object({
  toState: z.enum([
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
  ]),
  reason: z.string().min(1).max(1000),
});

export const projectLifecycle = z.object({
  projectId: z.string(),
  lifecycleState: z.string(),
  /** Null unless `suspended`. The state to resume to (§4.3). */
  priorLifecycleState: z.string().nullable(),
  version: z.number().int().positive(),
  /**
   * Transition history.
   *
   * By current state alone, a project resumed from `suspended` looks the same as
   * one that was never suspended.
   */
  transitions: z.array(
    z.object({
      fromState: z.string(),
      toState: z.string(),
      reason: z.string(),
      actorSubjectId: z.string().nullable(),
      occurredAt: isoDateTime,
    }),
  ),
});

/**
 * Notification sink.
 *
 * **Secrets are never returned.** `secretReference` is a reference, not a value,
 * but it is withheld too — a reference exposing a path like
 * `file:/run/secrets/x` is itself information about the deployment layout. Only
 * whether one is configured is returned.
 */
export const notificationSink = z
  .object({
    id: z.string(),
    url: z.string(),
    state: z.enum(["active", "paused"]),
    hasSecret: z.boolean(),
    createdAt: isoDateTime,
    version: z.number().int().positive(),
    /** Delivery status for this sink. The UI must say what is failing to send. */
    delivery: z.object({
      pending: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
    }),
  })
  .strict();

export const createNotificationSinkRequest = z.object({
  // https only. Notification bodies contain project identifiers.
  url: z.string().regex(/^https:\/\/[^@\s]+$/, "Must be an https URL"),
  /** A `file:` or `env:` reference. Never the value itself (05 §5.12). */
  secretReference: z.string().min(1),
});

export const updateNotificationSinkRequest = z.object({
  state: z.enum(["active", "paused"]),
});
