import { z } from "zod";
import { GATE_DECISIONS, GRADES, READINESS_STATUSES } from "@mpc/domain";
import { isoDateTime } from "./common.js";
import type { RouteDefinition } from "./routes.js";

/**
 * Project Registry content — spec 04 §4.2, 05 §5.6, 07 §7.2, 11 §11.3/§11.5, 12 §12.7.
 *
 * Kept apart from `resources.ts` because it is one context (Project): parties, the
 * confirmed/pending matrix, registration requests and the stakeholder/obligation history, plus
 * the read models the Project List, Project Overview and Claim Detail screens need.
 *
 * **Every status here is one of four values plus the evidence it rests on** (04 §4.2). There is
 * no nullable free-text "status" and no boolean "confirmed": an unrecorded fact reads `pending`,
 * and `confirmed` is refused without evidence — by the request schema, the route and the database.
 */

export const CONFIRMATION_STATUSES = ["confirmed", "pending", "rejected", "not_applicable"] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

/**
 * The Confirmed/Pending Matrix rows — 11 §11.5 (Rights, Consent, Issuer, SPV, Legal Structure,
 * Source Data) plus the project relationship that 05 §5.6 and 12 §12.7 name as a precondition.
 *
 * The offering-gate preconditions (`issuer_identified`, `legal_issuance_decision`, …) are not
 * here. They are R6 activation conditions owned by the issuer and legal (02 §2.3), and recording
 * them through the steward's matrix would let a data role write an issuance fact.
 */
export const PROJECT_FACT_KEYS = [
  "relationship",
  "consent",
  "rights",
  "issuer",
  "spv",
  "legal_structure",
  "source_data",
] as const;
export type ProjectFactKey = (typeof PROJECT_FACT_KEYS)[number];

/** What an evidence reference points at. The server resolves it inside the same project. */
export const EVIDENCE_KINDS = ["upload", "source_receipt", "attestation"] as const;

export const PARTY_ROLES = ["sponsor_operator", "host_country_spv", "issuer"] as const;

export const STAKEHOLDER_CATEGORIES = ["relationship", "consent", "obligation", "dispute"] as const;

/**
 * Registry label — 05 §5.10.
 *
 * `official_reference` is not set by any route: who designates the Reference is the "Reference
 * owner" precondition of 12 §12.7, which is not decided. `synthetic_test_project` is chosen at
 * creation and fixed by the database.
 */
export const REFERENCE_STATUSES = ["none", "official_reference", "synthetic_test_project"] as const;

export const evidenceReference = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  id: z.string().guid(),
});

const confirmationFields = {
  status: z.enum(CONFIRMATION_STATUSES),
  evidence: evidenceReference.nullable().default(null),
  asOf: z.string().date().nullable().default(null),
  /** Why this status. Recorded with the version; an unexplained change cannot be judged later. */
  reason: z.string().trim().min(1),
};

/** `confirmed` without evidence is the one combination that makes people believe something unproven. */
function requireEvidenceWhenConfirmed(
  value: { status: ConfirmationStatus; evidence: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.status === "confirmed" && value.evidence === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "confirmed requires an evidence reference",
    });
  }
}

export const recordConfirmationRequest = z
  .object(confirmationFields)
  .strict()
  .superRefine(requireEvidenceWhenConfirmed);

/** An explicit namespace distinguishes fixed matrix rows from historical catalog collisions. */
export const recordFactConfirmationRequest = z
  .object({ ...confirmationFields, factScope: z.enum(["legacy", "catalog"]).optional() })
  .strict()
  .superRefine(requireEvidenceWhenConfirmed);

const confirmationVersion = z.object({
  version: z.number().int().positive(),
  status: z.enum(CONFIRMATION_STATUSES),
  evidence: evidenceReference.nullable(),
  asOf: z.string().nullable(),
  reason: z.string(),
  recordedBySubjectId: z.string(),
  recordedAt: isoDateTime,
});

export const projectFactView = z.object({
  /** Legacy matrix key or an exact approved catalog claim-type key. */
  factKey: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  status: z.enum(CONFIRMATION_STATUSES),
  /** `false` when nothing was ever recorded — shown as pending, not as a decision someone made. */
  recorded: z.boolean(),
  evidence: evidenceReference.nullable(),
  asOf: z.string().nullable(),
  /** 0 when unrecorded. Pass as If-Match to record the next version. */
  version: z.number().int().nonnegative(),
  history: z.array(confirmationVersion),
});

export const projectFactList = z.object({
  projectId: z.string(),
  items: z.array(projectFactView),
  /** Stated with the matrix so a Reference badge next to it cannot be read as confirming it. */
  notMeaning: z.string(),
});

export const createProjectPartyRequest = z
  .object({
    partyRole: z.enum(PARTY_ROLES),
    legalName: z.string().trim().min(1).max(300),
    organizationId: z.string().guid().nullable().default(null),
    jurisdiction: z.string().length(3).nullable().default(null),
  })
  .strict();

export const projectParty = z.object({
  id: z.string(),
  projectId: z.string(),
  partyRole: z.enum(PARTY_ROLES),
  legalName: z.string(),
  organizationId: z.string().nullable(),
  jurisdiction: z.string().nullable(),
  status: z.enum(CONFIRMATION_STATUSES),
  evidence: evidenceReference.nullable(),
  asOf: z.string().nullable(),
  submittedBySubjectId: z.string(),
  submittedAt: isoDateTime,
  version: z.number().int().positive(),
  history: z.array(confirmationVersion),
});

export const createRegistrationRequest = z
  .object({ note: z.string().trim().min(1).max(2000) })
  .strict();

export const registrationRequestView = z.object({
  id: z.string(),
  projectId: z.string(),
  note: z.string(),
  requestedBySubjectId: z.string(),
  requestedAt: isoDateTime,
  /**
   * Read from the registry, not stored: a project-registry version published after the request.
   * A request is not publication and never becomes one by itself.
   */
  answeredByPublication: z.boolean(),
});

export const createStakeholderEventRequest = z
  .object({
    category: z.enum(STAKEHOLDER_CATEGORIES),
    summary: z.string().trim().min(1).max(2000),
    occurredOn: z.string().date(),
    status: z.enum(CONFIRMATION_STATUSES),
    evidence: evidenceReference.nullable().default(null),
    supersedesId: z.string().guid().nullable().default(null),
  })
  .strict()
  .superRefine(requireEvidenceWhenConfirmed);

export const stakeholderEvent = z.object({
  id: z.string(),
  projectId: z.string(),
  category: z.enum(STAKEHOLDER_CATEGORIES),
  summary: z.string(),
  occurredOn: z.string(),
  status: z.enum(CONFIRMATION_STATUSES),
  evidence: evidenceReference.nullable(),
  supersedesId: z.string().nullable(),
  /** Set when a later event corrects this one. The corrected event stays in the history. */
  supersededById: z.string().nullable(),
  recordedBySubjectId: z.string(),
  recordedAt: isoDateTime,
});

export const updateProjectRequest = z
  .object({
    name: z.string().trim().min(1).optional(),
    minerals: z.array(z.string().trim().min(1)).optional(),
    reason: z.string().trim().min(1),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.minerals !== undefined, {
    message: "Nothing to change",
  });

/** Project List filters — 11 §11.3. Every filter narrows; none widens past the caller's scope. */
export const projectListQuery = z
  .object({
    /** `mine`: projects where the caller holds an active review assignment. */
    assignment: z.enum(["mine"]).optional(),
    stage: z
      .enum([
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
      ])
      .optional(),
    hostCountry: z.string().length(3).optional(),
    /** Weakest claim grade in the project. */
    grade: z.enum(GRADES).optional(),
    /** `true`: the latest assessment of some gate is `gap` or `not_evaluable`. */
    gap: z.enum(["true"]).optional(),
    /** `true`: open stale signals exist. */
    stale: z.enum(["true"]).optional(),
    referenceStatus: z.enum(REFERENCE_STATUSES).optional(),
  })
  .strict();

export const projectListItem = z.object({
  id: z.string(),
  projectKey: z.string(),
  name: z.string(),
  hostCountryIso3: z.string(),
  minerals: z.array(z.string()),
  referenceStatus: z.enum(REFERENCE_STATUSES),
  relationshipStatus: z.enum(CONFIRMATION_STATUSES),
  lifecycleState: z.string(),
  /** Latest status of the Project Registry entry; `none` when nothing was ever published. */
  projectRegistryStatus: z.enum(["none", "draft", "published", "revoked", "superseded"]),
  /** Worst of the latest assessment per gate. `null` = never assessed, which is not a pass. */
  readinessSummary: z.enum(READINESS_STATUSES).nullable(),
  weakestGrade: z.enum(GRADES).nullable(),
  openStaleSignals: z.number().int().nonnegative(),
  ownerOrganizationId: z.string(),
  ownerOrganizationName: z.string(),
  version: z.number().int().positive(),
  updatedAt: isoDateTime,
});

const registryState = z.object({
  registryType: z.enum(["project", "verification", "asset"]),
  status: z.enum(["none", "draft", "published", "revoked", "superseded"]),
  latestVersion: z.number().int().nullable(),
  publishedAt: isoDateTime.nullable(),
  anchored: z.boolean(),
});

export const projectOverview = z.object({
  projectId: z.string(),
  projectKey: z.string(),
  name: z.string(),
  hostCountryIso3: z.string(),
  minerals: z.array(z.string()),
  referenceStatus: z.enum(REFERENCE_STATUSES),
  relationshipStatus: z.enum(CONFIRMATION_STATUSES),
  lifecycleState: z.string(),
  ownerOrganizationId: z.string(),
  ownerOrganizationName: z.string(),
  version: z.number().int().positive(),
  facts: z.array(projectFactView),
  parties: z.array(projectParty),
  lifecycle: z.array(
    z.object({
      fromState: z.string(),
      toState: z.string(),
      reason: z.string(),
      occurredAt: isoDateTime,
    }),
  ),
  registries: z.array(registryState),
  /** Latest assessment per gate. Kept apart from decisions: readiness is an input, not approval. */
  readiness: z.array(
    z.object({
      gateId: z.string(),
      status: z.enum(READINESS_STATUSES),
      generatedAt: isoDateTime,
      openGaps: z.array(z.object({ requirementId: z.string(), status: z.string(), reasonCode: z.string() })),
    }),
  ),
  decisions: z.array(
    z.object({
      gateId: z.string(),
      decision: z.enum(GATE_DECISIONS),
      decisionAuthority: z.string(),
      signedAt: isoDateTime,
    }),
  ),
  dataAge: z.object({
    newestSourceAsOf: isoDateTime.nullable(),
    oldestSourceAsOf: isoDateTime.nullable(),
    sourceCount: z.number().int().nonnegative(),
    openStaleSignals: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string()),
  registrationRequests: z.array(registrationRequestView),
  stakeholderEventCount: z.number().int().nonnegative(),
  /** Command and role only. Wallets and IP addresses stay on the audit screen. */
  activity: z.array(
    z.object({
      command: z.string(),
      effectiveRole: z.string().nullable(),
      occurredAt: isoDateTime,
    }),
  ),
});

export const createClaimDerivationRequest = z
  .object({
    formula: z.string().trim().min(1).max(2000),
    inputClaimIds: z.array(z.string().guid()).min(1).max(100),
    unit: z.string().trim().min(1).nullable().default(null),
    asOf: z.string().date().nullable().default(null),
  })
  .strict();

export const claimDerivation = z.object({
  claimId: z.string(),
  formula: z.string(),
  inputClaimIds: z.array(z.string()),
  unit: z.string().nullable(),
  asOf: z.string().nullable(),
  authorSubjectId: z.string(),
  recordedAt: isoDateTime,
});

export const claimDetail = z.object({
  id: z.string(),
  projectId: z.string(),
  claimType: z.string(),
  valueText: z.string(),
  unit: z.string().nullable(),
  asOf: z.string().nullable(),
  sourceCoordinate: z.record(z.string(), z.unknown()),
  sourceReceiptId: z.string().nullable(),
  evidenceTier: z.string().nullable(),
  verificationState: z.string(),
  grade: z.enum(GRADES),
  excludedByRule: z.boolean(),
  staleSince: isoDateTime.nullable(),
  version: z.number().int().positive(),
  attestations: z.array(
    z.object({
      id: z.string(),
      attestationType: z.string(),
      state: z.string(),
      limitations: z.string(),
      signedAt: isoDateTime,
      validUntil: isoDateTime.nullable(),
      credentialStatusAtSigning: z.unknown(),
      supersedesId: z.string().nullable(),
    }),
  ),
  conflicts: z.array(
    z.object({ id: z.string(), conflictType: z.string(), resolvedAt: isoDateTime.nullable(), createdAt: isoDateTime }),
  ),
  conflictingClaimIds: z.array(z.string()),
  derivation: claimDerivation.nullable(),
  /** Lineage edges touching this claim other than contradicts — supersede, revoke, derived_from. */
  lineage: z.array(
    z.object({ relationType: z.string(), fromId: z.string(), toId: z.string(), createdAt: isoDateTime }),
  ),
  history: z.array(
    z.object({
      command: z.string(),
      beforeVersion: z.number().nullable(),
      afterVersion: z.number().nullable(),
      occurredAt: isoDateTime,
    }),
  ),
  /** Registry versions that published this claim and their anchor. Proof of inclusion, not of truth. */
  anchors: z.array(
    z.object({
      entryVersionId: z.string(),
      merkleRoot: z.string().nullable(),
      txHash: z.string().nullable(),
      chainId: z.number().nullable(),
      transactionState: z.string().nullable(),
    }),
  ),
});

const base = { public: false, implemented: true } as const;

/** Routes of this context. Spread into `ROUTES` so the contract stays one list. */
export const PROJECT_REGISTRY_ROUTES: readonly RouteDefinition[] = [
  {
    ...base,
    method: "patch",
    path: "/api/v1/projects/{projectId}",
    summary: "Change a project's name or minerals — reference label and owner are not editable here",
    operationId: "updateProject",
    mutation: true,
    requiresIfMatch: true,
    action: "project.update",
    requestSchema: updateProjectRequest,
    responseSchema: projectListItem,
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/projects/{projectId}/overview",
    summary: "Project Overview — parties, confirmed/pending matrix, lifecycle, three registries, readiness and decisions apart",
    operationId: "getProjectOverview",
    mutation: false,
    requiresIfMatch: false,
    action: "project.read",
    responseSchema: projectOverview,
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/projects/{projectId}/facts",
    summary: "Confirmed/pending matrix with every recorded version",
    operationId: "listProjectFacts",
    mutation: false,
    requiresIfMatch: false,
    action: "project.read",
    responseSchema: projectFactList,
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/projects/{projectId}/facts/{factKey}/confirmations",
    summary: "Record the next version of a matrix fact — confirmed requires evidence in this project",
    operationId: "recordProjectFact",
    mutation: true,
    requiresIfMatch: true,
    action: "project.fact.record",
    requestSchema: recordFactConfirmationRequest,
    responseSchema: projectFactView,
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/projects/{projectId}/parties",
    summary: "Project parties with their confirmation status and history",
    operationId: "listProjectParties",
    mutation: false,
    requiresIfMatch: false,
    action: "project.read",
    responseSchema: projectParty.array(),
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/projects/{projectId}/parties",
    summary: "Submit a project party — it starts pending; submitting is not confirming",
    operationId: "createProjectParty",
    mutation: true,
    requiresIfMatch: false,
    action: "project.party.submit",
    requestSchema: createProjectPartyRequest,
    responseSchema: projectParty,
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/projects/{projectId}/parties/{partyId}/confirmations",
    summary: "Record a party's confirmation status — confirmed requires evidence in this project",
    operationId: "recordProjectPartyConfirmation",
    mutation: true,
    requiresIfMatch: true,
    action: "project.fact.record",
    requestSchema: recordConfirmationRequest,
    responseSchema: projectParty,
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/projects/{projectId}/registration-requests",
    summary: "Registration requests and whether a later Project Registry publication answered them",
    operationId: "listRegistrationRequests",
    mutation: false,
    requiresIfMatch: false,
    action: "project.read",
    responseSchema: registrationRequestView.array(),
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/projects/{projectId}/registration-requests",
    summary: "Ask for the Project Registry workflow to start — does not publish",
    operationId: "createRegistrationRequest",
    mutation: true,
    requiresIfMatch: false,
    action: "project.registration.request",
    requestSchema: createRegistrationRequest,
    responseSchema: registrationRequestView,
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/projects/{projectId}/stakeholder-events",
    summary: "Stakeholder and obligation event history — restricted, corrections kept",
    operationId: "listStakeholderEvents",
    mutation: false,
    requiresIfMatch: false,
    action: "project.read",
    responseSchema: stakeholderEvent.array(),
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/projects/{projectId}/stakeholder-events",
    summary: "Record a stakeholder or obligation event — append-only; a correction supersedes",
    operationId: "createStakeholderEvent",
    mutation: true,
    requiresIfMatch: false,
    action: "project.stakeholder.record",
    requestSchema: createStakeholderEventRequest,
    responseSchema: stakeholderEvent,
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/claims/{claimId}",
    summary: "Claim Detail — coordinate, attestations, conflicts, derivation, history, anchor",
    operationId: "getClaimDetail",
    mutation: false,
    requiresIfMatch: false,
    action: "evidence.read",
    responseSchema: claimDetail,
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/claims/{claimId}/derivations",
    summary: "Record how a derived claim was calculated — formula, inputs, unit, as-of, author",
    operationId: "createClaimDerivation",
    mutation: true,
    requiresIfMatch: false,
    action: "claim.curate",
    requestSchema: createClaimDerivationRequest,
    responseSchema: claimDerivation,
  },
];
