/**
 * API 클라이언트.
 *
 * 서버가 반환하는 error envelope(07 §7.1)를 그대로 보존한다. 화면이 오류를
 * "실패했습니다"로 뭉개면 사용자는 다음에 무엇을 해야 할지 알 수 없다.
 * `code`·`retryable`·`details.requiredRoles`·`details.accessRequestPath`가
 * 그대로 UI까지 온다(§11.7).
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
 * 요청 하나의 상한.
 *
 * 서버가 응답을 지연시키면 `fetch`는 스스로 끝나지 않는다. error envelope는
 * **응답을 받은** 경우의 설계이므로, 응답이 오지 않는 구간은 그 설계가 닿지
 * 못하고 화면이 무한 로딩에 머문다.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 타임아웃이 붙은 `fetch`.
 *
 * 호출부가 이미 `signal`을 넘겼으면 그것을 존중한다 — 취소 가능한 화면 요청의
 * signal을 여기서 덮어쓰면 그쪽 취소가 동작하지 않는다.
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
 * 세션 토큰 헤더.
 *
 * 토큰은 SIWE 서명을 검증한 뒤에만 발급된다. 서버는 토큰 원문을 저장하지 않고
 * 해시만 보관하며, 로그아웃하면 즉시 무효가 된다.
 */
function authHeader(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface SiweChallenge {
  nonce: string;
  statement: string;
  domain: string;
  /** 서명 대상 uri. 서버가 정하고 서버가 검증한다 — 여기서 추측하지 않는다. */
  uri: string;
  /**
   * 서명할 체인. **서버가 정하고 서버가 검증한다**.
   *
   * 여기에 97을 박아 두었을 때 stg·prod(56)에서 실지갑 로그인이 0건 성공했다.
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
  /** 역할로 허용되는 action. 메뉴를 거르는 데만 쓴다 — 판정은 서버가 한다. */
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
      // 07 §7.1: mutation에는 Idempotency-Key가 필수다. 네트워크 재시도가
      // 중복 등록을 만들지 않게 화면이 key를 생성해 보낸다.
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
 * 공식 출처 조회 — 2026-09-10 실사 A1.
 *
 * **확정은 이 경로에서만 나온다.** 화면이 `confirmed_from_source`를 직접 보내는
 * 것은 "올린 사람이 그렇다고 했다"를 "우리가 확인했다"로 기록하는 것이다.
 * 여기서 나오는 결과는 출처가 실제로 답한 것이며, 답하지 못하면 그 사실이 남는다.
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
 * claim conflict 기록.
 *
 * conflict가 생기면 grade가 재계산되어 claim의 version이 올라간다. 어느 버전을
 * 보고 기록하는지 `If-Match`로 밝힌다 — 밝히지 않으면 서버가 428로 거절하고,
 * 그 사이 누가 먼저 바꿨으면 412가 온다.
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

// --- 업로드 -----------------------------------------------------------------

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
 * base64 경로의 상한.
 *
 * 이보다 크면 multipart로 보낸다. base64는 본문이 33% 커지고 서버가 통째로
 * 메모리에 올린다 — 작은 파일에는 단순해서 좋고, 큰 파일에는 쓸 수 없다.
 */
const BASE64_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * 파일 업로드.
 *
 * 크기에 따라 경로를 고른다. 두 경로는 같은 content hash를 만들고 같은
 * quarantine 상태로 들어간다 — 사용자에게는 하나의 동작이다.
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

    // content-type을 직접 설정하지 않는다. 브라우저가 boundary를 붙여야 한다.
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
 * 이 프로젝트의 검토 case 목록.
 *
 * 배정을 만든 사람과 서명하는 사람이 다르므로, 검토자는 이 목록으로 자기
 * 배정을 찾는다. 목록에 보이는 것과 서명할 수 있는 것은 다른 문제다.
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
 * case 상태 전이.
 *
 * 보완 요청·반려·취소를 기록한다. 이유 없이 바꿀 수 없고, 어느 버전을 보고
 * 바꾸는지 `If-Match`로 밝힌다.
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
 * 서명된 attestation에 이의를 제기한다.
 *
 * 서명을 지우지 않는다. 서명 당시의 판단은 그대로 남고 상태만 추가된다.
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
 * 이의 해소.
 *
 * 기록을 지우지 않고 결과를 덧붙인다. `upheld`여도 검토가 유효로 돌아가지
 * 않는다 — 틀렸다고 확인된 것을 유효로 표시할 수 없다.
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
 * 서명 요청.
 *
 * `typedData`는 EIP-712 구조 그대로 온다. 서버는 대리 서명하지 않으므로
 * 브라우저가 이것을 지갑에 넘겨 서명한다. `humanReadablePayload`는 서명자가
 * 무엇에 서명하는지 읽을 수 있게 하는 것이며 서명 대상 자체는 typedData다.
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

// --- Registry 게시 / anchor --------------------------------------------------

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
 * 감사 로그 조회.
 *
 * `audit.events`는 append-only이고 superuser도 수정할 수 없다. 읽는 경로가
 * 없으면 그 보장이 운영에 쓰이지 못한다.
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

/** 멈춘 batch 재제출. 자동이 아니라 사람이 판단한다. */
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
 * anchor batch 상태 목록.
 *
 * batch를 만든 뒤 무슨 일이 일어났는지 볼 수 있어야 한다. 상태가 안 보이면
 * 제출이 막힌 것과 확정을 기다리는 것을 구분할 수 없다.
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
 * 활성화 조건 조회.
 *
 * **거래 함수가 없다.** `buy`·`subscribe`·`transfer`가 이 파일에 없는 것이
 * 의도다 — 클라이언트 코드의 모양이 곧 "무엇이 있는가"를 말한다.
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
   * 무게가 어디서 왔는가 — 04 §4.5.
   *
   * `manual`은 사람이 입력한 값으로 집계됐다는 뜻이다. 화면이 이것을 밝히지
   * 않으면 수동 집계 결과를 온체인 근거로 읽는다.
   */
  weightSource: "onchain_snapshot" | "manual";
  snapshotBlock: number | null;
  /**
   * 정족수의 분모 — 투표할 수 있었던 전체 무게.
   *
   * 던진 표의 합이 아니다. 투표를 열 때 고정되며 그 전에는 null이다.
   */
  eligibleWeight: string | null;
  /** 분모가 어디서 왔는가. `manual`이면 사람이 지정한 값이다. */
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

/** 투표. 무게는 decimal string이다 — number로 다루면 정밀도를 잃는다. */
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

// --- Public (무인증) ---------------------------------------------------------

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
  /** 공개 allowlist 안의 필드만 담긴다. 서버가 그것을 강제한다. */
  projection: Record<string, unknown>;
}

export interface PublicRegistryList {
  items: PublicRegistryListItem[];
  /** 다음 페이지를 요청하는 유일한 방법. 값을 해석하지 않고 그대로 돌려준다. */
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
  // 빈 값을 보내지 않는다. `q=`는 "빈 문자열로 검색"이고 서버가 거절한다.
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
  /** 무게는 decimal string이다. number로 옮기면 조용히 반올림된다(ADR-T07). */
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
  /** 정정·철회에만 있다. 나머지 종류는 registry version이 아니다. */
  registryVersion: {
    entryVersionId: string;
    version: string;
    supersededBy: string | null;
    projection: Record<string, unknown>;
  } | null;
  /** suspension에만 있다. 사유와 행위자는 공개하지 않는다. */
  lifecycle: { fromState: string; toState: string } | null;
  /** pause·dispute가 끝난 시각. 아직 열려 있으면 null. */
  resolvedAt: string | null;
}

export interface PublicDisclosureList {
  items: PublicDisclosureEvent[];
  nextCursor: string | null;
  /** 이 목록이 덮지 않는 사건 종류. 빈 목록을 "없었다"로 읽지 않게 한다. */
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

// --- 플랫폼 관리 ---------------------------------------------

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
  /** 로그인 가능한 지갑이 하나도 없다. 화면이 가장 먼저 말해야 하는 상태다. */
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
  input: { walletAddress: string; chainId: number; assuranceLevel: string },
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

// --- 워크스페이스 집계 ---------------------------------------

export interface RegistryEntrySummary {
  entryId: string;
  registryType: "project" | "verification" | "asset";
  publicKey: string;
  projectId: string | null;
  latestVersion: number;
  status: "draft" | "published" | "revoked" | "superseded";
  publishedAt: string | null;
  revokedAt: string | null;
  /** 게시와 anchor는 다른 사건이다. 한 칸에 합치지 않는다. */
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

// --- 내 활동 ------------------------------------------------------

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

// --- 공개 통합 검색 -----------------------------------------------

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

// --- 알림 ------------------------------------------------------------

export interface Notification {
  id: string;
  kind: "review_assigned" | "readiness_gap" | "evidence_stale" | "registry_revoked";
  /** 나에게 온 것인가, 내가 가진 역할에게 온 것인가. */
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
  delivery: { pending: number; delivered: number; failed: number; lastError: string | null };
}

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
