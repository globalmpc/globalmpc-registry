/**
 * API client.
 *
 * Preserves the server's error envelope (07 §7.1) as-is. If a screen flattens an error
 * into "failed", the user cannot tell what to do next.
 * `code`, `retryable`, `details.requiredRoles`, and `details.accessRequestPath`
 * reach the UI unchanged (§11.7).
 */

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: {
    reason?: string;
    requiredRoles?: string[];
    requiredAssurance?: string;
    accessRequestPath?: string;
    issues?: unknown[];
    resourceType?: string;
    expectedVersion?: string;
    currentVersion?: string;
    hint?: string;
  };
  retryable: boolean;
  correlationId: string;
}

/**
 * Upper bound for a single request.
 *
 * If the server stalls, `fetch` never ends on its own. The error envelope is
 * designed for the case where a **response arrives**, so a missing response falls outside
 * that design and the screen stays in an endless loading state.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `fetch` with a timeout.
 *
 * If the caller already passed a `signal`, respect it — overwriting the signal of a
 * cancellable screen request here breaks that cancellation.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly envelope: ApiErrorEnvelope,
  ) {
    super(envelope.message);
    this.name = "ApiError";
  }
}

/**
 * Session token header.
 *
 * A token is issued only after the SIWE signature is verified. The server stores only
 * the hash, never the raw token, and logout invalidates it immediately.
 */
function authHeader(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface SiweChallenge {
  nonce: string;
  statement: string;
  domain: string;
  /** URI to sign. The server decides it and the server verifies it — do not guess here. */
  uri: string;
  /**
   * Chain to sign on. **The server decides it and the server verifies it**.
   *
   * When 97 was hardcoded here, real-wallet login on stg/prod (56) succeeded zero times.
   */
  chainId: number;
  expiresAt: string;
}

export async function requestSiweNonce(walletAddress: string): Promise<SiweChallenge> {
  const response = await apiFetch("/api/v1/auth/siwe/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: walletAddress.toLowerCase() }),
  });
  return parse<SiweChallenge>(response);
}

export async function verifySiwe(
  message: string,
  signature: string,
): Promise<{ sessionToken: string; verifiedWalletAddress: string; expiresAt: string }> {
  const response = await apiFetch("/api/v1/auth/siwe/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  return parse<{ sessionToken: string; verifiedWalletAddress: string; expiresAt: string }>(
    response,
  );
}

export async function logout(token: string): Promise<void> {
  await apiFetch("/api/v1/auth/logout", { method: "POST", headers: authHeader(token) });
}

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    throw new ApiError(response.status, body as ApiErrorEnvelope);
  }
  return body as T;
}

export interface ProjectSummary {
  id: string;
  projectKey: string;
  name: string;
  hostCountryIso3: string;
  minerals: string[];
  referenceStatus: string;
  lifecycleState: string;
  readinessSummary: string | null;
  version: number;
  updatedAt: string;
  requestId: string;
  asOf: string;
}

export interface SessionInfo {
  authenticated: boolean;
  walletAddress?: string;
  chainId?: number;
  subjectId?: string | null;
  tenantId?: string | null;
  assuranceLevel?: string;
  roleBindings?: { role: string; organizationId: string | null; projectId: string | null }[];
  projectIds?: string[];
  /** Actions allowed by role. Used only to filter menus — the server makes the decision. */
  actions?: string[];
  requestId: string;
}

export async function getSession(token: string | null): Promise<SessionInfo> {
  const response = await apiFetch("/api/v1/auth/session", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<SessionInfo>(response);
}

export async function listProjects(token: string): Promise<{ items: ProjectSummary[] }> {
  const response = await apiFetch("/api/v1/projects", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: ProjectSummary[] }>(response);
}

export async function getProject(token: string, id: string): Promise<ProjectSummary> {
  const response = await apiFetch(`/api/v1/projects/${id}`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<ProjectSummary>(response);
}

/** An organization this account may name as a project owner. */
export interface OrganizationOption {
  id: string;
  legalName: string;
  jurisdiction: string;
}

/**
 * Organizations the registration form may offer.
 *
 * The server applies the same rule as project creation, so every option is one it accepts.
 * A session without a project creation role gets the 403 envelope with the required roles.
 */
export async function listOrganizations(token: string): Promise<{ items: OrganizationOption[] }> {
  const response = await apiFetch("/api/v1/organizations", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: OrganizationOption[] }>(response);
}

export interface CreateProjectInput {
  projectKey: string;
  name: string;
  hostCountryIso3: string;
  minerals: string[];
  ownerOrganizationId: string;
}

export async function createProject(
  token: string,
  input: CreateProjectInput,
  idempotencyKey: string,
): Promise<ProjectSummary> {
  const response = await apiFetch("/api/v1/projects", {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      // 07 §7.1: mutations require an Idempotency-Key. The screen generates and sends the key
      // so that network retries do not create duplicate records.
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  return parse<ProjectSummary>(response);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// --- Evidence ---------------------------------------------------------------

export interface SourceReceipt {
  id: string;
  result: string;
  retryable: boolean;
  nextAction: string;
  permitsCanonicalAcceptance: boolean;
  collectionMethod: string;
  rawHash: string;
  asOf: string;
  freshnessStatus: string;
  limitations: string[];
}

export interface Claim {
  id: string;
  claimType: string;
  valueText: string;
  unit: string | null;
  asOf: string | null;
  evidenceTier: string | null;
  verificationState: string;
  grade: string;
  version: number;
}

export async function listSourceReceipts(
  token: string,
  projectId: string,
): Promise<{ items: SourceReceipt[] }> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/source-receipts`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: SourceReceipt[] }>(response);
}

export async function listClaims(
  token: string,
  projectId: string,
): Promise<{ items: Claim[] }> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/claims`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: Claim[] }>(response);
}

export async function createSourceReceipt(
  token: string,
  projectId: string,
  input: Record<string, unknown>,
  key: string,
): Promise<SourceReceipt> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/source-receipts`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<SourceReceipt>(response);
}

/**
 * Official source lookup — 2026-09-10 audit A1.
 *
 * **Confirmation comes only from this path.** A screen sending `confirmed_from_source`
 * directly records "the uploader said so" as "we checked".
 * The result here is what the source actually answered; if it cannot answer, that fact is recorded.
 */
export async function collectFromSource(
  token: string,
  connectionId: string,
  projectId: string,
  queryBasis: Record<string, string>,
  key: string,
): Promise<{ result: string; confirmed: boolean; detail: string | null }> {
  const response = await apiFetch(`/api/v1/source-connections/${connectionId}/collect`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ projectId, queryBasis }),
  });
  return parse<{ result: string; confirmed: boolean; detail: string | null }>(response);
}

/**
 * Record a claim conflict.
 *
 * A conflict recomputes the grade and bumps the claim's version. State which version
 * you are recording against with `If-Match` — without it the server rejects with 428,
 * and if someone changed it first in the meantime you get 412.
 */
export async function createClaimConflict(
  token: string,
  claimId: string,
  version: number,
  conflictType: string,
  key: string,
): Promise<Claim> {
  const response = await apiFetch(`/api/v1/claims/${claimId}/conflicts`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify({ conflictType }),
  });
  return parse<Claim>(response);
}

export async function createClaim(
  token: string,
  projectId: string,
  input: Record<string, unknown>,
  key: string,
): Promise<Claim> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/claims`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<Claim>(response);
}

// --- Upload -------------------------------------------------------------------

export interface ObjectUpload {
  id: string;
  projectId: string;
  contentHash: string;
  byteSize: number;
  contentType: string;
  originalFilename: string | null;
  sensitivity: string;
  state: string;
  uploadedAt: string;
  scannedAt: string | null;
  promotedArtifactId: string | null;
  rejectionReason: string | null;
  nextActions: string[];
  version: number;
}

export interface ScannerStatus {
  state: "running" | "stale" | "never_seen" | "unknown";
  secondsSinceHeartbeat: number | null;
  detail: string;
}

export async function listUploads(
  token: string,
  projectId: string,
): Promise<{ items: ObjectUpload[]; scanner: ScannerStatus }> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/uploads`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: ObjectUpload[]; scanner: ScannerStatus }>(response);
}

/**
 * Upper bound for the base64 path.
 *
 * Larger files go as multipart. base64 inflates the body by 33% and the server loads it
 * entirely into memory — simple for small files, unusable for large ones.
 */
const BASE64_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * File upload.
 *
 * Picks a path by size. Both paths produce the same content hash and enter the same
 * quarantine state — to the user it is one action.
 */
export async function createUpload(
  token: string,
  projectId: string,
  file: File,
  key: string,
): Promise<ObjectUpload> {
  if (file.size > BASE64_UPLOAD_LIMIT_BYTES) {
    const form = new FormData();
    form.append("file", file, file.name);

    // Do not set content-type directly. The browser must attach the boundary.
    const response = await apiFetch(`/api/v1/projects/${projectId}/uploads/stream`, {
      method: "POST",
      headers: { ...authHeader(token), "idempotency-key": key },
      body: form,
    });
    return parse<ObjectUpload>(response);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  const response = await apiFetch(`/api/v1/projects/${projectId}/uploads`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      contentBase64: btoa(binary),
      contentType: file.type || "application/octet-stream",
      originalFilename: file.name,
    }),
  });
  return parse<ObjectUpload>(response);
}

export async function recordScanResult(
  token: string,
  uploadId: string,
  version: number,
  result: "clean" | "infected",
  key: string,
): Promise<ObjectUpload> {
  const response = await apiFetch(`/api/v1/uploads/${uploadId}/scan-result`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify({ result }),
  });
  return parse<ObjectUpload>(response);
}

export async function promoteUpload(
  token: string,
  uploadId: string,
  version: number,
  key: string,
): Promise<ObjectUpload> {
  const response = await apiFetch(`/api/v1/uploads/${uploadId}/promote`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify({}),
  });
  return parse<ObjectUpload>(response);
}

export async function createDownloadLink(
  token: string,
  uploadId: string,
  key: string,
): Promise<{ url: string; expiresInSeconds: number; warning: string }> {
  const response = await apiFetch(`/api/v1/uploads/${uploadId}/download-link`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({}),
  });
  return parse<{ url: string; expiresInSeconds: number; warning: string }>(response);
}

// --- Readiness / Gate -------------------------------------------------------

export interface RequirementResult {
  requirementId: string;
  status: string;
  applicable: boolean;
  reasonCode: string;
  missing: string[];
}

export interface ReadinessAssessment {
  id: string;
  status: string;
  requirementResults: RequirementResult[];
  canonicalResultHash: string;
  evaluatedAsOf: string;
  ruleSetVersion: string;
  authority: string;
  limitations: string[];
  legalEffect: string;
  disclaimerCodes: string[];
}

export async function recomputeReadiness(
  token: string,
  projectId: string,
  policySetId: string,
  key: string,
): Promise<ReadinessAssessment> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/readiness-assessments`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ policySetId }),
  });
  return parse<ReadinessAssessment>(response);
}

export async function getReadiness(
  token: string,
  assessmentId: string,
): Promise<ReadinessAssessment> {
  const response = await apiFetch(`/api/v1/readiness-assessments/${assessmentId}`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<ReadinessAssessment>(response);
}

export interface GateDecision {
  id: string;
  decision: string;
  rationale: string;
  signedAt: string;
}

export async function recordGateDecision(
  token: string,
  projectId: string,
  input: Record<string, unknown>,
  key: string,
): Promise<GateDecision> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/gate-decisions`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<GateDecision>(response);
}

// --- Verification -----------------------------------------------------------

export interface VerificationCase {
  id: string;
  assignmentId: string;
  state: string;
  evidenceSnapshotHash: string;
  claimIds: string[];
  reviewerSubjectId?: string;
  assignedAt?: string;
  version?: number;
  transitions?: { fromState: string; toState: string; reason: string; occurredAt: string }[];
}

/**
 * Review cases for this project.
 *
 * The person who creates an assignment differs from the person who signs, so reviewers
 * find their assignments in this list. Appearing in the list and being able to sign are separate questions.
 */
export async function listVerificationCases(
  token: string,
  projectId: string,
): Promise<{ items: VerificationCase[] }> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/verification-cases`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: VerificationCase[] }>(response);
}

/** What a review assignment on one project can use — real rows, not seed ids. */
export interface ReviewAssignmentOptions {
  reviewers: {
    subjectId: string;
    displayName: string;
    roles: string[];
    credentials: {
      id: string;
      credentialType: string;
      issuerReference: string;
      scope: string[];
      jurisdiction: string[];
      expiresAt: string | null;
    }[];
  }[];
  schemas: {
    id: string;
    schemaKey: string;
    schemaVersion: string;
    attestationType: string;
    jurisdictionProfile: string;
  }[];
}

/**
 * Reviewers who can sign on this project, their valid credentials, and active schemas.
 *
 * Authorized with the same action as creating the assignment, so only the assigner reads it.
 */
export async function getReviewAssignmentOptions(
  token: string,
  projectId: string,
): Promise<ReviewAssignmentOptions> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/review-assignment-options`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<ReviewAssignmentOptions>(response);
}

export async function createVerificationCase(
  token: string,
  input: Record<string, unknown>,
  key: string,
): Promise<VerificationCase> {
  const response = await apiFetch("/api/v1/verification-cases", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<VerificationCase>(response);
}

export interface AttestationDraft {
  id: string;
  caseId: string;
  state: string;
  attestationType: string;
  claimScope: string[];
  limitations: string;
  payloadHash: string;
}

/**
 * Case state transition.
 *
 * Records a request for changes, rejection, or cancellation. Cannot change without a reason, and
 * states the version it is changing against with `If-Match`.
 */
export async function transitionCase(
  token: string,
  caseId: string,
  version: number,
  input: { toState: string; reason: string },
  key: string,
): Promise<{ state: string; previousState: string; version: number }> {
  const response = await apiFetch(`/api/v1/verification-cases/${caseId}/transitions`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify(input),
  });
  return parse<{ state: string; previousState: string; version: number }>(response);
}

/**
 * Dispute a signed attestation.
 *
 * Does not delete the signature. The judgment at signing time stays; only a status is added.
 */
export async function disputeAttestation(
  token: string,
  attestationId: string,
  input: { reasonCode: string; detail: string },
  key: string,
): Promise<{ state: string; previousState: string; payloadHash: string }> {
  const response = await apiFetch(`/api/v1/attestations/${attestationId}/disputes`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<{ state: string; previousState: string; payloadHash: string }>(response);
}

export interface AttestationDispute {
  id: string;
  attestationId: string;
  reasonCode: string;
  detail: string;
  raisedAt: string;
  resolvedAt: string | null;
  outcome: string | null;
  resolution: string | null;
}

export async function listDisputes(
  token: string,
  attestationId: string,
): Promise<{ items: AttestationDispute[] }> {
  const response = await apiFetch(`/api/v1/attestations/${attestationId}/disputes`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: AttestationDispute[] }>(response);
}

/**
 * Resolve a dispute.
 *
 * Appends the outcome without deleting the record. Even if `upheld`, the review does not
 * return to valid — something confirmed wrong cannot be shown as valid.
 */
export async function resolveDispute(
  token: string,
  disputeId: string,
  input: { outcome: "upheld" | "dismissed"; resolution: string },
  key: string,
): Promise<{ outcome: string; attestationState: string; unresolvedDisputes: number }> {
  const response = await apiFetch(`/api/v1/disputes/${disputeId}/resolution`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<{ outcome: string; attestationState: string; unresolvedDisputes: number }>(
    response,
  );
}

export async function createAttestation(
  token: string,
  caseId: string,
  input: Record<string, unknown>,
  key: string,
): Promise<AttestationDraft> {
  const response = await apiFetch(`/api/v1/verification-cases/${caseId}/attestations`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<AttestationDraft>(response);
}

/**
 * Signature request.
 *
 * `typedData` arrives in its EIP-712 structure as-is. The server does not sign on anyone's behalf,
 * so the browser passes it to the wallet to sign. `humanReadablePayload` lets the signer
 * read what they are signing; the signed payload itself is typedData.
 */
export interface SignatureRequest {
  signatureRequestId: string;
  humanReadablePayload: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  payloadHash: string;
  nonce: string;
  expiresAt: string;
}

export async function createSignatureRequest(
  token: string,
  attestationId: string,
  key: string,
): Promise<SignatureRequest> {
  const response = await apiFetch(`/api/v1/attestations/${attestationId}/signature-requests`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({}),
  });
  return parse<SignatureRequest>(response);
}

export interface SignedAttestation {
  id: string;
  state: string;
  signerWalletAddress: string;
  evidenceSnapshotHash: string;
  ongoingApplicability: string;
  pastSignatureRemainsValid: boolean;
}

export async function submitSignature(
  token: string,
  attestationId: string,
  input: { signatureRequestId: string; signature: string },
  key: string,
): Promise<SignedAttestation> {
  const response = await apiFetch(`/api/v1/attestations/${attestationId}/signatures`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<SignedAttestation>(response);
}

// --- Registry publication / anchor ---------------------------------------------

export interface PublishedVersion {
  id: string;
  entryId: string;
  registryType: string;
  publicKey: string;
  version: number;
  status: string;
  contentHash: string;
  publishedAt: string;
}

export async function publishRegistryEntry(
  token: string,
  input: Record<string, unknown>,
  key: string,
): Promise<PublishedVersion> {
  const response = await apiFetch("/api/v1/registry-entries", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<PublishedVersion>(response);
}

export interface AnchorBatch {
  id: string;
  batchId: string;
  root: string;
  manifestHash: string;
  recordCount: number;
  confirmationState: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  command: string;
  resourceType: string;
  resourceId: string | null;
  actorWallet: string | null;
  effectiveRole: string | null;
  beforeVersion: number | null;
  afterVersion: number | null;
  reason: string | null;
  correlationId: string;
  projectId: string | null;
}

/**
 * Audit log query.
 *
 * `audit.events` is append-only and not even a superuser can modify it. Without a read
 * path, that guarantee is of no use in operations.
 */
export async function listAuditEvents(
  token: string,
  filters: { resourceType?: string; projectId?: string; command?: string } = {},
): Promise<{ items: AuditEvent[] }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const response = await apiFetch(`/api/v1/audit-events?${query.toString()}`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: AuditEvent[] }>(response);
}

export interface OutboxBacklog {
  pending: number;
  oldestPendingAt: string | null;
  oldestPendingAgeSeconds: number | null;
  publishedLastHour: number;
  byEventType: { eventType: string; pending: number }[];
}

export async function getOutboxBacklog(token: string): Promise<OutboxBacklog> {
  const response = await apiFetch("/api/v1/outbox-backlog", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<OutboxBacklog>(response);
}

/** Resubmit a stalled batch. A person decides, not an automatic process. */
export async function resubmitAnchorBatch(
  token: string,
  batchId: string,
  key: string,
): Promise<{ confirmationState: string; previousState: string }> {
  const response = await apiFetch(`/api/v1/anchor-batches/${batchId}/resubmit`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({}),
  });
  return parse<{ confirmationState: string; previousState: string }>(response);
}

export interface AnchorProposal {
  safeAddress: string;
  calldataHash: string;
  state: string;
  createdAt: string;
}

export interface AnchorBatchStatus extends AnchorBatch {
  createdAt: string;
  chainId: number;
  transactionHash: string | null;
  blockNumber: string | null;
  confirmations: number;
  attempts: number;
  lastError: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  reorgCount: number;
  needsAttention: boolean;
  proposal: AnchorProposal | null;
}

/**
 * Anchor batch status list.
 *
 * It must be possible to see what happened after a batch was created. If status is hidden,
 * a blocked submission cannot be told apart from one awaiting confirmation.
 */
export async function listAnchorBatches(token: string): Promise<{ items: AnchorBatchStatus[] }> {
  const response = await apiFetch("/api/v1/anchor-batches", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: AnchorBatchStatus[] }>(response);
}

export async function createAnchorBatch(token: string, key: string): Promise<AnchorBatch> {
  const response = await apiFetch("/api/v1/anchor-batches", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({}),
  });
  return parse<AnchorBatch>(response);
}

// --- Asset/Offering gate (OD-07) --------------------------------------------

/**
 * Activation condition query.
 *
 * **There are no trading functions.** `buy`, `subscribe`, and `transfer` are absent from this file
 * by design — the shape of the client code itself says "what exists".
 */
export interface OfferingGateStatus {
  projectId: string;
  activatable: boolean;
  missing: { key: string; label: string; why: string; owner: string }[];
  unsupported: string[];
  absenceNotice: string;
  notMeaning: string;
}

export async function getOfferingGate(
  token: string,
  projectId: string,
): Promise<OfferingGateStatus> {
  const response = await apiFetch(`/api/v1/projects/${projectId}/offering-gate`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<OfferingGateStatus>(response);
}

// --- Authority Registry -----------------------------------------------------

export interface AuthorityEntry {
  id: string;
  name: string;
  jurisdiction: string;
  proves: string[];
  doesNotProve: string[];
  recognizedScope: string[];
  verificationMethod: string;
  state: string;
  validFrom: string;
  validUntil: string | null;
  adapterState: "active" | "manual" | "pending_access" | "blocked" | "none";
  adapterStateReason: string | null;
  connectionKey: string | null;
  callable: boolean;
  nextAction: string | null;
}

export async function listAuthorities(token: string): Promise<{ items: AuthorityEntry[] }> {
  const response = await apiFetch("/api/v1/authorities", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: AuthorityEntry[] }>(response);
}

export interface JurisdictionProfile {
  jurisdiction: string;
  authorities: AuthorityEntry[];
  activeCount: number;
  manualCount: number;
  pendingCount: number;
  limitations: string[];
}

export async function getJurisdictionProfile(
  token: string,
  jurisdiction: string,
): Promise<JurisdictionProfile> {
  const response = await apiFetch(`/api/v1/jurisdictions/${jurisdiction}/profile`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<JurisdictionProfile>(response);
}

// --- Governance -------------------------------------------------------------

export interface GovernanceProposal {
  id: string;
  space: "protocol" | "project";
  projectId: string | null;
  proposalType: string;
  title: string;
  rationale: string;
  state: string;
  quorum: { numerator: number; denominator: number };
  threshold: { numerator: number; denominator: number };
  createdAt: string;
  version: number;
  tally: {
    forWeight: string;
    againstWeight: string;
    abstainWeight: string;
    participatedWeight: string;
    quorumMet: boolean;
    thresholdMet: boolean;
    provisionalOutcome: string;
    reason: string;
  };
  transitions: { fromState: string; toState: string; reason: string; occurredAt: string }[];
  limitations: string[];
  /**
   * Where the weight came from — 04 §4.5.
   *
   * `manual` means the tally used values a person entered. If the screen does not state this,
   * a manual tally reads as on-chain evidence.
   */
  weightSource: "onchain_snapshot" | "manual";
  snapshotBlock: number | null;
  /**
   * Quorum denominator — the total weight that could have voted.
   *
   * Not the sum of votes cast. Fixed when voting opens; null before that.
   */
  eligibleWeight: string | null;
  /** Where the denominator came from. `manual` means a person set the value. */
  eligibleWeightSource: "onchain_total_supply" | "manual" | null;
}

export async function listProposals(token: string): Promise<{ items: GovernanceProposal[] }> {
  const response = await apiFetch("/api/v1/governance/proposals", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: GovernanceProposal[] }>(response);
}

export async function createProposal(
  token: string,
  input: Record<string, unknown>,
  key: string,
): Promise<GovernanceProposal> {
  const response = await apiFetch("/api/v1/governance/proposals", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<GovernanceProposal>(response);
}

export async function transitionProposal(
  token: string,
  proposalId: string,
  version: number,
  input: { toState: string; reason: string },
  key: string,
): Promise<GovernanceProposal> {
  const response = await apiFetch(`/api/v1/governance/proposals/${proposalId}/transitions`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify(input),
  });
  return parse<GovernanceProposal>(response);
}

/** Vote. Weight is a decimal string — handling it as a number loses precision. */
export async function castVote(
  token: string,
  proposalId: string,
  input: { choice: "for" | "against" | "abstain"; weight: string },
  key: string,
): Promise<GovernanceProposal> {
  const response = await apiFetch(`/api/v1/governance/proposals/${proposalId}/votes`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<GovernanceProposal>(response);
}

// --- Public (unauthenticated) ---------------------------------------------------

export interface PublicProjection {
  entryVersionId: string;
  version: string;
  status: string;
  limitations: string[];
  legalEffect: string;
  disclaimerCodes: string[];
  publishedAt: string | null;
  revokedAt: string | null;
  history: { entryVersionId: string; version: string; status: string }[];
  [key: string]: unknown;
}

export async function getPublicRegistryEntry(
  registryType: string,
  publicKey: string,
): Promise<PublicProjection> {
  const response = await apiFetch(`/api/v1/public/registries/${registryType}/${publicKey}`, {
    cache: "no-store",
  });
  return parse<PublicProjection>(response);
}

export interface InclusionProof {
  entryVersionId: string;
  leafHash: string;
  proof: string[];
  root: string;
  batchId: string;
  chainId: number;
  transactionHash: string | null;
  blockNumber: number | null;
  confirmationState: string;
  included: boolean;
  merkleVerified: boolean;
  proves: string[];
  doesNotProve: string[];
}

export async function getInclusionProof(entryVersionId: string): Promise<InclusionProof> {
  const response = await apiFetch(`/api/v1/public/proofs/${entryVersionId}`, { cache: "no-store" });
  return parse<InclusionProof>(response);
}

export interface PublicRegistryListItem {
  publicKey: string;
  entryVersionId: string;
  version: string;
  status: string;
  publishedAt: string | null;
  revokedAt: string | null;
  supersededBy: string | null;
  /** Contains only fields in the public allowlist. The server enforces it. */
  projection: Record<string, unknown>;
}

export interface PublicRegistryList {
  items: PublicRegistryListItem[];
  /** The only way to request the next page. Return the value as-is without interpreting it. */
  nextCursor: string | null;
  sort: string;
}

export interface PublicListQuery {
  q?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

export async function listPublicRegistryEntries(
  registryType: string,
  query: PublicListQuery = {},
): Promise<PublicRegistryList> {
  // Do not send empty values. `q=` means "search for the empty string" and the server rejects it.
  const search = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
  const response = await apiFetch(
    `/api/v1/public/registries/${registryType}?${search.toString()}`,
    { cache: "no-store" },
  );
  return parse<PublicRegistryList>(response);
}

export interface PublicProposal {
  id: string;
  proposalType: string;
  title: string;
  rationale: string;
  state: string;
  quorum: { numerator: number; denominator: number };
  threshold: { numerator: number; denominator: number };
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  createdAt: string;
  /** Weight is a decimal string. Converting it to a number rounds silently (ADR-T07). */
  tally: { for: string; against: string; abstain: string; voterCount: number };
}

export interface PublicProposalDetail extends PublicProposal {
  transitions: {
    fromState: string;
    toState: string;
    reason: string;
    occurredAt: string;
    tallySnapshot: Record<string, unknown> | null;
  }[];
}

export async function listPublicProposals(
  query: { limit?: number; cursor?: string } = {},
): Promise<{ items: PublicProposal[]; nextCursor: string | null }> {
  const search = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
  const response = await apiFetch(`/api/v1/public/governance/proposals?${search.toString()}`, {
    cache: "no-store",
  });
  return parse(response);
}

export async function getPublicProposal(proposalId: string): Promise<PublicProposalDetail> {
  const response = await apiFetch(`/api/v1/public/governance/proposals/${proposalId}`, {
    cache: "no-store",
  });
  return parse<PublicProposalDetail>(response);
}

export interface PublicDisclosureEvent {
  eventId: string;
  eventKind: "revocation" | "source_correction" | "suspension" | "pause" | "dispute";
  occurredAt: string;
  registryType: "project" | "verification" | "asset";
  publicKey: string;
  /** Present only for corrections and withdrawals. Other kinds are not registry versions. */
  registryVersion: {
    entryVersionId: string;
    version: string;
    supersededBy: string | null;
    projection: Record<string, unknown>;
  } | null;
  /** Present only for suspensions. The reason and actor are not public. */
  lifecycle: { fromState: string; toState: string } | null;
  /** When the pause or dispute ended. Null while still open. */
  resolvedAt: string | null;
}

export interface PublicDisclosureList {
  items: PublicDisclosureEvent[];
  nextCursor: string | null;
  /** Event kinds this list does not cover. Keeps an empty list from reading as "none happened". */
  notCovered: { kind: string; reason: string }[];
}

export async function listPublicDisclosures(
  query: { limit?: number; cursor?: string } = {},
): Promise<PublicDisclosureList> {
  const search = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
  const response = await apiFetch(`/api/v1/public/disclosures?${search.toString()}`, {
    cache: "no-store",
  });
  return parse<PublicDisclosureList>(response);
}

// --- Platform administration ---------------------------------------

export interface AdminWallet {
  id: string;
  walletAddress: string;
  chainId: number;
  assuranceLevel: string;
  boundAt: string | null;
  disabledAt: string | null;
  version: number;
}

export interface AdminSubject {
  id: string;
  displayName: string;
  kind: "person" | "service";
  wallets: AdminWallet[];
  roles: { id: string; role: string; projectId: string | null; grantedAt: string; revokedAt: string | null }[];
  /** No wallet can log in. This is the first state the screen must report. */
  locked: boolean;
}

export interface RoleGrant {
  id: string;
  subjectId: string;
  subjectName: string;
  role: string;
  projectId: string | null;
  reason: string;
  requestedBySubjectId: string;
  requestedAt: string;
  state: "pending" | "approved" | "rejected" | "withdrawn";
  decidedBySubjectId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export async function listAdminSubjects(token: string): Promise<{ items: AdminSubject[] }> {
  const response = await apiFetch("/api/v1/admin/subjects", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: AdminSubject[] }>(response);
}

export async function createAdminSubject(
  token: string,
  key: string,
  input: { displayName: string; kind?: "person" | "service" },
): Promise<AdminSubject> {
  const response = await apiFetch("/api/v1/admin/subjects", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<AdminSubject>(response);
}

export async function bindAdminWallet(
  token: string,
  key: string,
  subjectId: string,
  input: { walletAddress: string; chainId: number; assuranceLevel: string; justification: string },
): Promise<AdminSubject> {
  const response = await apiFetch(`/api/v1/admin/subjects/${subjectId}/wallets`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<AdminSubject>(response);
}

export async function disableAdminWallet(
  token: string,
  key: string,
  walletId: string,
  version: number,
  input: { reasonCode: string; detail: string },
): Promise<AdminSubject> {
  const response = await apiFetch(`/api/v1/admin/wallets/${walletId}/disable`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify(input),
  });
  return parse<AdminSubject>(response);
}

// --- Review registries (02 §2.8) -------------------------------------------

/** Path segment of one review registry under `/api/v1/review-registry/`. */
export type RegistrySegment = "credentials" | "attestation-schemas" | "policy-sets";

/**
 * A proposal to add one version of a credential, attestation schema or policy set.
 *
 * `itemVersion` counts versions of the item; `version` is this record's own version, sent back
 * as If-Match when deciding.
 */
export interface RegistryProposal {
  id: string;
  kind: "credential" | "attestation_schema" | "policy_set";
  itemKey: string;
  itemVersion: number;
  payload: Record<string, unknown>;
  rationale: string;
  effectiveFrom: string;
  proposedBySubjectId: string;
  proposedAt: string;
  state: "pending" | "approved" | "rejected";
  decidedBySubjectId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  /** The registry record approval created. Null until approved. */
  materializedId: string | null;
  version: number;
}

export async function listRegistryProposals(
  token: string,
  segment: RegistrySegment,
): Promise<{ items: RegistryProposal[] }> {
  const response = await apiFetch(`/api/v1/review-registry/${segment}/proposals`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: RegistryProposal[] }>(response);
}

export async function proposeRegistryItem(
  token: string,
  key: string,
  segment: RegistrySegment,
  input: Record<string, unknown>,
): Promise<RegistryProposal> {
  const response = await apiFetch(`/api/v1/review-registry/${segment}/proposals`, {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<RegistryProposal>(response);
}

export async function decideRegistryProposal(
  token: string,
  key: string,
  segment: RegistrySegment,
  proposalId: string,
  version: number,
  input: { decision: "approve" | "reject"; reason: string },
): Promise<RegistryProposal> {
  const response = await apiFetch(
    `/api/v1/review-registry/${segment}/proposals/${proposalId}/decision`,
    {
      method: "POST",
      headers: {
        ...authHeader(token),
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": `"${version}"`,
      },
      body: JSON.stringify(input),
    },
  );
  return parse<RegistryProposal>(response);
}

export async function listRoleGrants(token: string): Promise<{ items: RoleGrant[] }> {
  const response = await apiFetch("/api/v1/admin/role-grants", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: RoleGrant[] }>(response);
}

export async function createRoleGrant(
  token: string,
  key: string,
  input: { subjectId: string; role: string; reason: string },
): Promise<RoleGrant> {
  const response = await apiFetch("/api/v1/admin/role-grants", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<RoleGrant>(response);
}

export async function decideRoleGrant(
  token: string,
  key: string,
  grantId: string,
  version: number,
  input: { decision: "approve" | "reject"; reason: string },
): Promise<RoleGrant> {
  const response = await apiFetch(`/api/v1/admin/role-grants/${grantId}/decision`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify(input),
  });
  return parse<RoleGrant>(response);
}

/** Revocation reason codes. Same list as the server's `ROLE_REVOCATION_REASON_CODES`. */
export type RoleRevocationReasonCode =
  | "offboarding"
  | "duty_change"
  | "security_concern"
  | "granted_in_error";

export interface RoleRevocation {
  id: string;
  roleBindingId: string;
  subjectId: string;
  subjectName: string;
  role: string;
  projectId: string | null;
  reasonCode: RoleRevocationReasonCode;
  reason: string;
  requestedBySubjectId: string;
  requestedAt: string;
  state: "pending" | "approved" | "rejected" | "withdrawn";
  decidedBySubjectId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export async function listRoleRevocations(token: string): Promise<{ items: RoleRevocation[] }> {
  const response = await apiFetch("/api/v1/admin/role-revocations", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: RoleRevocation[] }>(response);
}

export async function createRoleRevocation(
  token: string,
  key: string,
  input: { roleBindingId: string; reasonCode: RoleRevocationReasonCode; reason: string },
): Promise<RoleRevocation> {
  const response = await apiFetch("/api/v1/admin/role-revocations", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<RoleRevocation>(response);
}

export async function decideRoleRevocation(
  token: string,
  key: string,
  revocationId: string,
  version: number,
  input: { decision: "approve" | "reject"; reason: string },
): Promise<RoleRevocation> {
  const response = await apiFetch(`/api/v1/admin/role-revocations/${revocationId}/decision`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify(input),
  });
  return parse<RoleRevocation>(response);
}

// --- Workspace summary -------------------------------------------

export interface RegistryEntrySummary {
  entryId: string;
  registryType: "project" | "verification" | "asset";
  publicKey: string;
  projectId: string | null;
  latestVersion: number;
  status: "draft" | "published" | "revoked" | "superseded";
  publishedAt: string | null;
  revokedAt: string | null;
  /** Publication and anchoring are separate events. Do not merge them into one column. */
  anchored: boolean;
}

export interface MyWork {
  assignedToMe: {
    caseId: string;
    projectId: string;
    projectName: string;
    state: string;
    assignedAt: string;
    conflictStatus: string;
  }[];
  waitingOnOthers: { kind: string; id: string; summary: string; since: string }[];
  unassigned: {
    kind: string;
    id: string;
    projectId: string | null;
    summary: string;
    since: string;
  }[];
}

export async function listRegistryEntries(
  token: string,
): Promise<{ items: RegistryEntrySummary[] }> {
  const response = await apiFetch("/api/v1/registry-entries", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: RegistryEntrySummary[] }>(response);
}

export async function getMyWork(token: string): Promise<MyWork> {
  const response = await apiFetch("/api/v1/my-work", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<MyWork>(response);
}

// --- My activity ---------------------------------------------------

export interface MyActivityItem {
  id: string;
  occurredAt: string;
  command: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  effectiveRole: string | null;
  reason: string | null;
  signatureOrTx: string | null;
}

export interface MyActivity {
  items: MyActivityItem[];
  nextCursor: string | null;
}

export async function getMyActivity(token: string, cursor?: string): Promise<MyActivity> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await apiFetch(`/api/v1/me/activity${query}`, {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<MyActivity>(response);
}

// --- Public unified search -----------------------------------------

export interface PublicSearchMatch {
  matchedOn:
    | "transaction_hash"
    | "merkle_root"
    | "leaf_hash"
    | "batch_id"
    | "public_key"
    | "text";
  registryType: "project" | "verification" | "asset";
  publicKey: string;
  entryVersionId: string;
  version: string;
  status: string;
  merkleRoot: string | null;
  transactionHash: string | null;
}

export interface PublicSearchResult {
  query: string;
  chainId: number;
  kind: "hash" | "text";
  matches: PublicSearchMatch[];
}

export async function searchPublicRecords(q: string): Promise<PublicSearchResult> {
  const response = await apiFetch(`/api/v1/public/search?q=${encodeURIComponent(q)}`, {
    cache: "no-store",
  });
  return parse<PublicSearchResult>(response);
}

// --- Notifications ---------------------------------------------------

export interface Notification {
  id: string;
  kind: "review_assigned" | "readiness_gap" | "evidence_stale" | "registry_revoked";
  /** Addressed to me, or to a role I hold? */
  audience: "you" | "role";
  audienceRole: string | null;
  projectId: string | null;
  summary: string;
  link: string;
  occurredAt: string;
  read: boolean;
}

export async function listNotifications(token: string): Promise<{ items: Notification[] }> {
  const response = await apiFetch("/api/v1/notifications", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: Notification[] }>(response);
}

export async function markNotificationRead(
  token: string,
  key: string,
  notificationId: string,
): Promise<Notification> {
  const response = await apiFetch(`/api/v1/notifications/${notificationId}/read`, {
    method: "POST",
    headers: { ...authHeader(token), "idempotency-key": key },
  });
  return parse<Notification>(response);
}

export interface NotificationSink {
  id: string;
  url: string;
  state: "active" | "paused";
  hasSecret: boolean;
  createdAt: string;
  version: number;
  delivery: {
    pending: number;
    delivered: number;
    failed: number;
    lastError: NotificationDeliveryError | null;
  };
}

/** A failed delivery's category. The server never returns the receiver's own answer (W-087). */
export type NotificationDeliveryError =
  | "rejected_destination"
  | "secret_unavailable"
  | "http_error"
  | "timeout"
  | "network_error"
  | "response_too_large";

export const NOTIFICATION_DELIVERY_ERROR_TEXT: Readonly<Record<NotificationDeliveryError, string>> = {
  rejected_destination:
    "Destination refused — the address is not public, or the name did not resolve",
  secret_unavailable: "The signing secret is not available to the worker",
  http_error: "The receiver answered with an error",
  timeout: "The receiver did not answer in time",
  network_error: "Could not connect to the receiver",
  response_too_large: "The receiver's reply was too large",
};

export async function listNotificationSinks(
  token: string,
): Promise<{ items: NotificationSink[] }> {
  const response = await apiFetch("/api/v1/admin/notification-sinks", {
    headers: authHeader(token),
    cache: "no-store",
  });
  return parse<{ items: NotificationSink[] }>(response);
}

export async function createNotificationSink(
  token: string,
  key: string,
  input: { url: string; secretReference: string },
): Promise<NotificationSink> {
  const response = await apiFetch("/api/v1/admin/notification-sinks", {
    method: "POST",
    headers: { ...authHeader(token), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(input),
  });
  return parse<NotificationSink>(response);
}

export async function updateNotificationSinkState(
  token: string,
  key: string,
  sinkId: string,
  version: number,
  state: "active" | "paused",
): Promise<NotificationSink> {
  const response = await apiFetch(`/api/v1/admin/notification-sinks/${sinkId}/state`, {
    method: "POST",
    headers: {
      ...authHeader(token),
      "content-type": "application/json",
      "idempotency-key": key,
      "if-match": `"${version}"`,
    },
    body: JSON.stringify({ state }),
  });
  return parse<NotificationSink>(response);
}
