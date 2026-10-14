import { ApiError, apiFetch, newIdempotencyKey, type ApiErrorEnvelope } from "./api";

/**
 * Project Registry client — Project List, Project Overview, confirmed/pending matrix, parties,
 * registration requests, stakeholder history and Claim Detail (spec 11 §11.3/§11.5, 07 §7.2).
 *
 * Kept apart from `api.ts` because it serves one context. The error envelope is preserved the
 * same way: a screen that flattens an error cannot tell the user what to do next (§11.7).
 */

export type ConfirmationStatus = "confirmed" | "pending" | "rejected" | "not_applicable";
export type EvidenceKind = "upload" | "source_receipt" | "attestation";

export interface EvidenceReference {
  kind: EvidenceKind;
  id: string;
}

export interface ConfirmationVersion {
  version: number;
  status: ConfirmationStatus;
  evidence: EvidenceReference | null;
  asOf: string | null;
  reason: string;
  recordedBySubjectId: string;
  recordedAt: string;
}

export interface ProjectFact {
  factKey: string;
  status: ConfirmationStatus;
  recorded: boolean;
  evidence: EvidenceReference | null;
  asOf: string | null;
  version: number;
  history: ConfirmationVersion[];
}

export interface ProjectParty {
  id: string;
  partyRole: "sponsor_operator" | "host_country_spv" | "issuer";
  legalName: string;
  organizationId: string | null;
  jurisdiction: string | null;
  status: ConfirmationStatus;
  evidence: EvidenceReference | null;
  asOf: string | null;
  submittedAt: string;
  version: number;
  history: ConfirmationVersion[];
}

export interface RegistrationRequest {
  id: string;
  note: string;
  requestedAt: string;
  answeredByPublication: boolean;
}

export interface StakeholderEvent {
  id: string;
  category: "relationship" | "consent" | "obligation" | "dispute";
  summary: string;
  occurredOn: string;
  status: ConfirmationStatus;
  evidence: EvidenceReference | null;
  supersedesId: string | null;
  supersededById: string | null;
  recordedAt: string;
}

export interface ProjectListItem {
  id: string;
  projectKey: string;
  name: string;
  hostCountryIso3: string;
  minerals: string[];
  referenceStatus: "none" | "official_reference" | "synthetic_test_project";
  relationshipStatus: ConfirmationStatus;
  lifecycleState: string;
  projectRegistryStatus: "none" | "draft" | "published" | "revoked" | "superseded";
  readinessSummary: "ok" | "watch" | "gap" | "not_evaluable" | null;
  weakestGrade: "rejected" | "unverified" | "self_reported" | "partially_verified" | "verified" | null;
  openStaleSignals: number;
  ownerOrganizationId: string;
  ownerOrganizationName: string;
  version: number;
  updatedAt: string;
}

export interface ProjectListFilters {
  assignment?: "mine";
  stage?: string;
  hostCountry?: string;
  grade?: string;
  gap?: "true";
  stale?: "true";
  referenceStatus?: string;
}

export interface RegistryState {
  registryType: "project" | "verification" | "asset";
  status: "none" | "draft" | "published" | "revoked" | "superseded";
  latestVersion: number | null;
  publishedAt: string | null;
  anchored: boolean;
}

export interface ProjectOverview {
  projectId: string;
  projectKey: string;
  name: string;
  hostCountryIso3: string;
  minerals: string[];
  referenceStatus: ProjectListItem["referenceStatus"];
  relationshipStatus: ConfirmationStatus;
  lifecycleState: string;
  ownerOrganizationName: string;
  version: number;
  facts: ProjectFact[];
  parties: ProjectParty[];
  lifecycle: { fromState: string; toState: string; reason: string; occurredAt: string }[];
  registries: RegistryState[];
  readiness: {
    gateId: string;
    status: "ok" | "watch" | "gap" | "not_evaluable";
    generatedAt: string;
    openGaps: { requirementId: string; status: string; reasonCode: string }[];
  }[];
  decisions: { gateId: string; decision: string; decisionAuthority: string; signedAt: string }[];
  dataAge: {
    newestSourceAsOf: string | null;
    oldestSourceAsOf: string | null;
    sourceCount: number;
    openStaleSignals: number;
  };
  limitations: string[];
  registrationRequests: RegistrationRequest[];
  stakeholderEventCount: number;
  activity: { command: string; effectiveRole: string | null; occurredAt: string }[];
  requestId: string;
  asOf: string;
}

export interface ClaimDetail {
  id: string;
  projectId: string;
  claimType: string;
  valueText: string;
  unit: string | null;
  asOf: string | null;
  sourceCoordinate: Record<string, unknown>;
  sourceReceiptId: string | null;
  evidenceTier: string | null;
  verificationState: string;
  grade: "rejected" | "unverified" | "self_reported" | "partially_verified" | "verified";
  excludedByRule: boolean;
  staleSince: string | null;
  version: number;
  attestations: {
    id: string;
    attestationType: string;
    state: string;
    limitations: string;
    signedAt: string;
    validUntil: string | null;
    credentialStatusAtSigning: unknown;
    supersedesId: string | null;
  }[];
  conflicts: { id: string; conflictType: string; resolvedAt: string | null; createdAt: string }[];
  conflictingClaimIds: string[];
  derivation: {
    formula: string;
    inputClaimIds: string[];
    unit: string | null;
    asOf: string | null;
    authorSubjectId: string;
    recordedAt: string;
  } | null;
  lineage: { relationType: string; fromId: string; toId: string; createdAt: string }[];
  history: { command: string; beforeVersion: number | null; afterVersion: number | null; occurredAt: string }[];
  anchors: {
    entryVersionId: string;
    merkleRoot: string | null;
    txHash: string | null;
    chainId: number | null;
    transactionState: string | null;
  }[];
  responseAsOf: string;
}

async function read<T>(response: Response): Promise<T> {
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorEnvelope);
  return body as T;
}

function get<T>(token: string, path: string): Promise<T> {
  return apiFetch(path, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" }).then(
    (response) => read<T>(response),
  );
}

function mutate<T>(
  token: string,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  ifMatch?: number,
): Promise<T> {
  return apiFetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      // One key per user action; a network retry of the same request reuses it.
      "idempotency-key": newIdempotencyKey(),
      ...(ifMatch === undefined ? {} : { "if-match": `"${ifMatch}"` }),
    },
    body: JSON.stringify(body),
  }).then((response) => read<T>(response));
}

export function listProjectItems(
  token: string,
  filters: ProjectListFilters,
): Promise<{ items: ProjectListItem[]; truncated: boolean; limit: number; asOf: string }> {
  const query = new URLSearchParams(
    Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  return get(token, `/api/v1/projects${query ? `?${query}` : ""}`);
}

export function getProjectOverview(token: string, projectId: string): Promise<ProjectOverview> {
  return get(token, `/api/v1/projects/${projectId}/overview`);
}

export function updateProject(
  token: string,
  projectId: string,
  version: number,
  body: { name?: string; minerals?: string[]; reason: string },
): Promise<ProjectListItem> {
  return mutate(token, "PATCH", `/api/v1/projects/${projectId}`, body, version);
}

export interface ConfirmationInput {
  status: ConfirmationStatus;
  evidence: EvidenceReference | null;
  asOf: string | null;
  reason: string;
}

export function recordProjectFact(
  token: string,
  projectId: string,
  factKey: string,
  version: number,
  body: ConfirmationInput,
): Promise<ProjectFact> {
  return mutate(token, "POST", `/api/v1/projects/${projectId}/facts/${factKey}/confirmations`, body, version);
}

export function createProjectParty(
  token: string,
  projectId: string,
  body: { partyRole: ProjectParty["partyRole"]; legalName: string; jurisdiction: string | null },
): Promise<ProjectParty> {
  return mutate(token, "POST", `/api/v1/projects/${projectId}/parties`, body);
}

export function recordPartyConfirmation(
  token: string,
  projectId: string,
  partyId: string,
  version: number,
  body: ConfirmationInput,
): Promise<ProjectParty> {
  return mutate(
    token,
    "POST",
    `/api/v1/projects/${projectId}/parties/${partyId}/confirmations`,
    body,
    version,
  );
}

export function createRegistrationRequest(
  token: string,
  projectId: string,
  note: string,
): Promise<RegistrationRequest> {
  return mutate(token, "POST", `/api/v1/projects/${projectId}/registration-requests`, { note });
}

export function listStakeholderEvents(
  token: string,
  projectId: string,
): Promise<{ items: StakeholderEvent[] }> {
  return get(token, `/api/v1/projects/${projectId}/stakeholder-events`);
}

export function createStakeholderEvent(
  token: string,
  projectId: string,
  body: {
    category: StakeholderEvent["category"];
    summary: string;
    occurredOn: string;
    status: ConfirmationStatus;
    evidence: EvidenceReference | null;
    supersedesId: string | null;
  },
): Promise<StakeholderEvent> {
  return mutate(token, "POST", `/api/v1/projects/${projectId}/stakeholder-events`, body);
}

export function getClaimDetail(token: string, claimId: string): Promise<ClaimDetail> {
  return get(token, `/api/v1/claims/${claimId}`);
}
