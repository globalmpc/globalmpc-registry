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
 * 미확인 항목 — 04 §4.2.
 * nullable text가 아니라 4상태 + evidence reference로 관리한다.
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

/** Claim — 수치는 decimal string + 단위 + 기준일이다(ADR-T07). */
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
  /** 이 값이 나온 Source Receipt. `null`은 근거 없음이며 숨기지 않는다. */
  sourceReceiptId: z.string().nullable(),
  /** 근거가 흔들렸는가 — AC-21. 검토가 없었다는 뜻이 아니다. */
  stale: z.boolean(),
  staleSince: z.string().nullable(),
  staleReason: z.string().nullable(),
  version: z.number().int().positive(),
});

/**
 * anchor batch 상태 — 08 §8.9.
 *
 * `confirmationState`를 가공하지 않고 그대로 노출한다. 화면에서 "완료/진행중"으로
 * 뭉개면 `included`와 `confirmed`의 차이가 사라진다 — 그 차이가 이 기록의 핵심이다.
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
  /** 마지막 실패 사유. 다음 행동을 정하는 데 필요하다. */
  lastError: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  confirmedAt: isoDateTime.nullable(),
  /** 이 batch가 한 번이라도 뒤집힌 적이 있는가. 재확정돼도 사실은 남는다. */
  reorgCount: z.number().int(),
  /** 사람이 봐야 하는 상태인가. 자동으로 풀리지 않는다. */
  needsAttention: z.boolean(),
  /**
   * Safe 제안 정보. EOA 제출이 막힌 체인에서만 생긴다.
   *
   * **제안이 있다는 것은 제출됐다는 뜻이 아니다.** 서명 수집과 실행은 Safe에서
   * 사람이 하며, 그때까지 체인에는 아무것도 없다.
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
 * 업로드 — 05 §5.2, 06 §6.7.
 *
 * **업로드는 evidence가 아니다.** quarantine을 지나 검사를 통과해야 승격된다.
 * 두 상태를 같은 화면에서 같은 말로 보여주면 검사되지 않은 파일이 검토 대상
 * 자료로 읽힌다.
 *
 * `originalFilename`은 restricted다. 응답에는 담되 공개 projection에는 갈 수 없다.
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
  /** 이 상태에서 다음에 할 수 있는 것. 추측하게 두지 않는다. */
  nextActions: z.array(z.string()),
  version: z.number().int().positive(),
});

/** 다운로드용 단기 URL. 영구 공개 URL은 만들지 않는다(06 §6.7). */
/**
 * 검사기 생존.
 *
 * 업로드 목록에 붙는다. `promote`는 `scanned_clean`에서만 전이하므로 검사 worker가
 * 없는 배포에서 업로드는 `quarantined`에 영원히 머물고, **그 정지는 오류가 아니라
 * 대기처럼 보인다.** 목록이 그 구분을 스스로 말한다.
 */
export const scannerStatus = z.object({
  state: z.enum(["running", "stale", "never_seen", "unknown"]),
  secondsSinceHeartbeat: z.number().int().nonnegative().nullable(),
  detail: z.string(),
});

export const uploadDownloadLink = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int().positive(),
  /** 이 링크가 무엇을 우회하지 않는지. 받은 사람은 권한 검사를 다시 지나지 않는다. */
  warning: z.string(),
});

/**
 * Audit 이벤트 — 02 §2.6.
 *
 * `audit.events`는 append-only이며 superuser도 수정할 수 없다. 읽기 경로가
 * 없으면 그 보장이 운영에 쓰이지 못한다 — 누가 무엇을 했는지 확인하려면
 * DB에 직접 붙어야 하고, 그 자체가 감사의 신뢰를 떨어뜨린다.
 *
 * **payload는 노출하지 않는다.** detail에 PII를 넣지 않기로 했지만, 약속이
 * 깨졌을 때 이 화면이 최초 유출 경로가 된다.
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
 * 이벤트 발행 backlog — 07 §7.5.
 *
 * outbox는 at-least-once다. 쌓이기 시작하면 이벤트가 사라지는 것이 아니라
 * **늦어진다** — 그 구분이 대응을 정한다.
 */
export const outboxBacklog = z.object({
  pending: z.number().int(),
  oldestPendingAt: isoDateTime.nullable(),
  /** 가장 오래된 미발행 이벤트의 지연(초). null이면 backlog가 없다. */
  oldestPendingAgeSeconds: z.number().int().nullable(),
  publishedLastHour: z.number().int(),
  byEventType: z.array(z.object({ eventType: z.string(), pending: z.number().int() })),
});

/**
 * Verification Case 요약 — 04 §4.4.
 *
 * 검토자는 자기에게 배정된 case를 찾을 수 있어야 한다. 배정을 만든 사람과
 * 서명하는 사람이 다르므로(02 §2.4), 화면 상태로만 전달하면 검토자는 자기
 * 배정에 도달할 방법이 없다.
 */
export const verificationCaseSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  assignmentId: z.string(),
  schemaId: z.string(),
  state: z.string(),
  evidenceSnapshotHash: hex32,
  claimIds: z.array(z.string()),
  /** 이 case에 배정된 검토자. 로그인한 사람이 그 사람인지 화면이 대조한다. */
  reviewerSubjectId: z.string(),
  assignedAt: isoDateTime,
  /** 상태 전이마다 올라간다. If-Match가 이 값을 본다. */
  version: z.number().int().positive(),
  /** 지나온 상태와 그 이유. 되돌아가도 경로는 남는다. */
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
 * case 상태 전이 요청 — 04 §4.4.
 *
 * 상태를 바꾸는 것은 사실을 기록하는 것이다. 이유 없이 바꿀 수 없다 —
 * `changes_requested`는 무엇을 보완해야 하는지, `cancelled`는 왜 그만두는지가
 * 없으면 다음 사람이 판단할 근거가 사라진다.
 */
export const transitionCaseRequest = z.object({
  toState: z.enum([
    "in_review",
    "changes_requested",
    "declined",
    "cancelled",
  ]),
  reason: z.string().min(1, "상태를 바꾼 이유는 비워 둘 수 없다"),
});

/**
 * attestation 이의 제기 — 04 §4.2.
 *
 * **서명을 지우지 않는다.** 서명 당시의 판단은 그대로 남고 `disputed`라는 새
 * 사실이 추가된다. 서명을 삭제하면 "누가 무엇을 언제 판단했는가"를 잃는다.
 */
export const disputeAttestationRequest = z.object({
  reasonCode: z.string().min(1),
  detail: z.string().min(1, "이의 제기 사유는 비워 둘 수 없다"),
});

/** 제기된 이의. 해소돼도 지워지지 않는다. */
export const attestationDispute = z.object({
  id: z.string(),
  attestationId: z.string(),
  reasonCode: z.string(),
  detail: z.string(),
  raisedAt: isoDateTime,
  resolvedAt: isoDateTime.nullable(),
  /** `upheld`·`dismissed`. 미해소면 null. */
  outcome: z.string().nullable(),
  resolution: z.string().nullable(),
});

/**
 * 이의 해소 요청 — 04 §4.2.
 *
 * `upheld`는 이의가 맞았다는 뜻이고, `dismissed`는 검토가 유지된다는 뜻이다.
 * 어느 쪽이든 **이의 기록 자체는 남는다** — 해소됐다고 지우면 "한 번 문제가
 * 제기됐다"는 사실이 사라진다.
 */
export const resolveDisputeRequest = z.object({
  outcome: z.enum(["upheld", "dismissed"]),
  resolution: z.string().min(1, "해소 근거는 비워 둘 수 없다"),
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
  /** AC-01: 빈 문자열을 허용하지 않는다. */
  limitations: z.string().min(1),
  credentialStatusSnapshot: z.object({
    credentialId: z.string(),
    statusAtSigning: z.string(),
    validAtAttestationTime: z.boolean(),
  }),
  /** AC-17: 현재 상태는 별도로 표시한다. 과거를 덮어쓰지 않는다. */
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
  limitations: z.string().min(1, "limitations는 비워 둘 수 없다"),
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

/** Gate Decision — 사람이 내린다. readiness와 별도 record다(§4.2). */
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
 * **거래 필드가 없다.** `price`·`amount`·`subscribe` 같은 이름이 이 스키마에
 * 없는 것이 의도다 — 응답 형태가 곧 "무엇이 있는가"를 말한다.
 *
 * 남은 조건과 담당만 반환한다. 화면이 빈 자리 대신 그것을 보여준다.
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
  /** 근거 없이 충족으로 표시된 항목. 빠진 것보다 위험하다. */
  unsupported: z.array(z.string()),
  /** 기능이 없다는 사실 자체를 문구로 보낸다. */
  absenceNotice: z.string(),
  notMeaning: z.string(),
});

/**
 * 근거 신호 — AC-21.
 *
 * 대상을 바꾸지 않고 "이 산출물이 딛고 있던 근거가 흔들렸다"는 사실만 남긴다.
 * **열려 있다는 것은 재검토가 필요하다는 뜻이지 그 기록이 틀렸다는 뜻이 아니다.**
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
  /** 이 신호로 할 수 있는 것. 화면이 추측하지 않게 서버가 정한다. */
  nextActions: z.array(z.string()),
});

/**
 * 신호 종결 — AC-21.
 *
 * 공개 기록을 내리는 것은 세상이 보는 것을 바꾸는 행위다. 그 판정을 자동화하지
 * 않으므로 이유를 반드시 받는다.
 */
export const resolveStaleSignalRequest = z.object({
  resolution: z.enum(["superseded", "revoked", "dismissed"]),
  note: z.string().min(1),
});

/**
 * 두 번째 검토 — AC-29.
 *
 * 수동 확인은 API 응답도 서명도 없이 한 사람의 진술이 유일한 근거다. 다른
 * 사람이 같은 등록부를 조회해 확인해야 확정된다.
 */
export const secondReviewRequest = z.object({
  /** 두 번째 조회에서 무엇을 봤는가. 같다는 말만으로는 검토가 아니다. */
  observation: z.string().min(1),
  confirmed: z.boolean(),
});

/**
 * 출처 조회 요청 — 05 §5.12, OD-42.
 *
 * `result`를 받지 않는다. 무엇이 나왔는지는 출처가 정하는 것이지 부르는 쪽이
 * 정하는 것이 아니다. 요청은 "무엇을 근거로 조회하는가"만 말한다.
 */
export const sourceCollectRequest = z.object({
  projectId: z.string().uuid(),
  /** 조회 조건. receipt에 그대로 남아 재현의 근거가 된다. */
  queryBasis: z.record(z.string(), z.string()),
});

/**
 * 출처 조회 결과 — 05 §5.12.
 *
 * **실패도 receipt를 만든다.** "기록 없음"(404)과 "출처 장애"(503)는 둘 다
 * 사실이고, 남기지 않으면 다음 사람이 같은 조회를 반복한다.
 */
export const sourceCollectResult = z.object({
  receiptId: z.string(),
  connectionId: z.string(),
  authorityId: z.string(),
  /** 12개 결과 중 하나. `confirmed_from_source`만 확인된 것이다. */
  result: z.string(),
  /** 성공했는가. `result`를 화면이 다시 해석하지 않게 서버가 판정한다. */
  confirmed: z.boolean(),
  /** 출처가 밝힌 기준일. 조회 시각과 다르다. */
  effectiveAt: z.string().nullable(),
  /** authority가 선언한 한계가 반드시 포함된다. */
  limitations: z.array(z.string()),
  detail: z.string().nullable(),
});

/**
 * Authority 등록 — 02 §2.8, 05 §5.11, REQ-DAPP-043.
 *
 * **`doesNotProve`가 필수이고 비어 있을 수 없다.** 한계 없는 authority는
 * 존재하지 않는다. 선택 항목으로 두면 급할 때 비워두고, 그 receipt를 읽는 쪽은
 * 전체 확인으로 오해한다.
 *
 * `state`를 받지 않는다. 등록은 항상 `proposed`에서 시작하며, 등록하는 사람이
 * 승인 상태를 정할 수 있으면 §2.8의 분리가 무너진다.
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
  /** 왜 이 기관을 후보로 올리는가. 이력의 첫 줄이 된다. */
  reason: z.string().min(1),
});

/** 갱신. 관할은 바꿀 수 없다 — 다른 관할이면 다른 기관이다. */
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
 * 상태 전환.
 *
 * 등록한 사람은 승인할 수 없다(02 §2.8: 운영자 단독 `accepted` 전환 금지).
 * 그 판정은 서버가 한다 — 화면이 버튼을 감추는 것으로는 막지 못한다.
 */
export const authorityStateRequest = z.object({
  state: z.enum(["under_review", "accepted", "suspended", "expired", "revoked", "superseded"]),
  reason: z.string().min(1),
});

/** Authority 이력 한 줄. 그때 이 기관이 무엇을 확인해 준다고 했는지가 남는다. */
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
 * 연동 구성 — 02 §2.8.
 *
 * `state`를 `active`로 직접 넣을 수 있지만, 기관이 `accepted`가 아니면 DB가
 * 거절한다. **API 성공을 authority 승인으로 바꾸지 못하게** 하는 것이 §2.8의
 * 요구다.
 *
 * 자격증명 값을 받지 않는다. `secretReference`만 받는다 — 값이 API를 지나가면
 * 요청 로그·에러 리포트에 남는다.
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
  /** 호출 대상. 비밀이 아니므로 보여준다 — 자격증명은 여기 없다. */
  endpoint: z.string().nullable(),
  /** 자격증명이 설정돼 있는가. 값은 반환하지 않는다. */
  hasSecret: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  version: z.number().int(),
});

/**
 * Authority Registry 항목 — 05 §5.11, OD-42·OD-43.
 *
 * `doesNotProve`를 항상 함께 반환한다. 무엇을 확인해 주는지만 보여주면 읽는
 * 쪽이 전체 확인으로 오해한다.
 *
 * `adapterState`가 `active`가 아닌 것도 목록에 남긴다 — 빼면 "왜 이 기관은
 * 없나"를 알 수 없고, 활성으로 두면 있지도 않은 연동을 약속한다.
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
  /** 연동 상태. `active`만 실제로 호출된다. */
  adapterState: z.enum(["active", "manual", "pending_access", "blocked", "none"]),
  adapterStateReason: z.string().nullable(),
  connectionKey: z.string().nullable(),
  /** 지금 이 출처를 호출할 수 있는가. 못 하면 다음에 무엇을 할지 알려준다. */
  callable: z.boolean(),
  nextAction: z.string().nullable(),
});

/** Jurisdiction Profile 요약 — 관할별 연동 현황. */
export const jurisdictionProfileView = z.object({
  jurisdiction: z.string(),
  authorities: z.array(authorityEntry),
  activeCount: z.number().int(),
  manualCount: z.number().int(),
  pendingCount: z.number().int(),
  /** 이 profile이 약속하지 않는 것. 미확인 통합을 과장하지 않는다(R5 gate). */
  limitations: z.array(z.string()),
});

/**
 * Governance 제안 — 04 §4.5, OD-06.
 *
 * 정족수·통과 기준을 응답에 담는다. 제안 시점 값을 고정해 두므로 나중에 규칙이
 * 바뀌어도 결과가 뒤집히지 않는다(non-retroactive).
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
  /** 현재 집계. 무게는 decimal string이다(ADR-T07). */
  tally: z.object({
    forWeight: z.string(),
    againstWeight: z.string(),
    abstainWeight: z.string(),
    participatedWeight: z.string(),
    quorumMet: z.boolean(),
    thresholdMet: z.boolean(),
    /** 지금 마감하면 어떤 결과인지. 확정이 아니다. */
    provisionalOutcome: z.string(),
    reason: z.string(),
  }),
  /** 지나온 경로. 정족수 미달과 취소는 결과만 같아 보인다. */
  transitions: z.array(
    z.object({
      fromState: z.string(),
      toState: z.string(),
      reason: z.string(),
      occurredAt: isoDateTime,
    }),
  ),
  /**
   * 무게가 어디서 왔는가.
   *
   * `manual`이면 던지는 사람이 값을 지정했다는 뜻이다 — 그 결과를 온체인
   * 근거로 읽으면 안 된다.
   */
  weightSource: z.enum(["onchain_snapshot", "manual"]),
  /** 스냅숏 블록. `manual`이면 null이다. */
  snapshotBlock: z.string().nullable(),
  /**
   * 정족수의 분모 — 투표할 수 있었던 전체 무게.
   *
   * 던진 표의 합이 아니다. 그러면 `참여 × D >= 참여 × N`이 항상 참이라
   * `no_quorum`이 구조적으로 나올 수 없다(09 §9.6). 투표를 열 때 고정되며 그
   * 전에는 null이다.
   */
  eligibleWeight: z.string().nullable(),
  /**
   * 분모가 어디서 왔는가.
   *
   * `manual`이면 사람이 지정한 값이다 — 그 결과를 온체인 근거로 읽으면 안 된다.
   */
  eligibleWeightSource: z.enum(["onchain_total_supply", "manual"]).nullable(),
  /** 이 제안이 만들 수 없는 것. 투표는 오프체인 사실을 만들지 않는다. */
  limitations: z.array(z.string()),
});

export const createProposalRequest = z.object({
  space: z.enum(["protocol", "project"]),
  projectId: z.string().uuid().nullable().default(null),
  proposalType: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1, "제안 이유는 비워 둘 수 없다"),
  quorumNumerator: z.number().int().positive().default(1),
  quorumDenominator: z.number().int().positive().default(4),
  thresholdNumerator: z.number().int().positive().default(1),
  thresholdDenominator: z.number().int().positive().default(2),
  /**
   * 정족수의 분모 후보.
   *
   * 온체인 총공급을 읽을 수 있는 제안에서는 무시된다. 읽을 수 없는 제안은 이
   * 값이 있어야 투표를 열 수 있다.
   */
  eligibleWeight: z
    .string()
    .regex(/^[1-9]\d*$/, "정족수 분모는 1 이상의 정수 문자열이어야 한다")
    .nullable()
    .default(null),
});

export const castVoteRequest = z.object({
  choice: z.enum(["for", "against", "abstain"]),
  /**
   * 투표 무게. decimal string이다 — JSON number는 정밀도를 잃는다.
   *
   * **온체인 스냅숏이 있으면 무시된다.** 그 경우 서버가 스냅숏 시점의 잔고로
   * 정하므로 선택이다. 필수로 두면 클라이언트가 무시될 값을 지어내야 하고,
   * 그 값이 반영된다고 읽는다.
   */
  weight: z
    .string()
    .regex(/^\d+$/, "무게는 음이 아닌 정수 문자열이어야 한다")
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
  reason: z.string().min(1, "상태를 바꾼 이유는 비워 둘 수 없다"),
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
 * 공개 projection — 05 §5.7 allowlist를 통과한 것만.
 *
 * `.strict()`가 중요하다. 정의되지 않은 필드가 응답에 섞이면 allowlist가
 * 무의미해진다(AC-22).
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
    /** 자연인 이름·등록번호가 아니라 pseudonymous handle이 기본이다(AC-32). */
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
 * inclusion proof — AC-23.
 *
 * `included: true`가 무엇을 뜻하는지 응답 자체에 담는다. 클라이언트가 이것을
 * "검증됨"으로 번역하지 못하게 `proves`와 `doesNotProve`를 함께 반환한다.
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
  proves: z.array(z.string()).describe("이 증명이 확인하는 것"),
  doesNotProve: z.array(z.string()).describe("이 증명이 확인하지 않는 것"),
  /**
   * leaf를 다시 만들 때 쓸 규격 — 2026-09-09 결정.
   *
   * 셋 다 **비식별 버전 문자열**이다. 주체나 원문은 담지 않는다 — 그것은
   * 별개 결정이다. 이 셋이 없으면 검증자가 어떤 규격으로 재구성해야 하는지
   * 알 수 없다.
   *
   * `serializationVersion`이 `literal("1")`이 아닌 이유: 규격을 올리면 값이
   * 바뀐다(CLAUDE.md). 계약이 `"1"`을 강제하면 그날 응답이 계약을 위반한다.
   */
  policyVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  serializationVersion: z.string().min(1),
});

export const PROOF_PROVES = [
  "이 공개 version의 바이트가 해당 anchor batch에 포함됐다",
  "포함 이후 그 바이트가 바뀌지 않았다",
] as const;

export const PROOF_DOES_NOT_PROVE = [
  "원문 내용의 사실성",
  "검토자의 authority 적격성",
  "법률 효력이나 발행 적법성",
  "투자 적합성이나 수익성",
  "정부 승인이나 MPC의 보증",
] as const;

export const sourceResultEnumValues = SOURCE_RESULTS;

/**
 * 공개 목록 한 줄.
 *
 * projection을 펼치지 않고 `projection` 아래에 둔다. 펼치면 목록 메타(`publicKey`·
 * `entryVersionId`)와 projection 필드가 같은 평면에 섞이고, 그러면 "공개 허용
 * 필드만 나갔는가"를 응답만 보고 판정할 수 없다. 중첩은 그 판정을 한 줄로 만든다.
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
 * 공개 목록 — 정렬과 페이지네이션이 계약에 고정된다.
 *
 * `nextCursor`가 불투명 문자열인 이유: 클라이언트가 정렬 키를 조립하기 시작하면
 * 정렬을 바꿀 수 없게 된다. 다음 페이지를 요청하는 방법은 이 값을 그대로 돌려주는
 * 것 하나뿐이다.
 */
export const publicRegistryList = z.object({
  items: z.array(publicRegistryListItem),
  nextCursor: z.string().nullable(),
  /** 정렬은 고정이다. 클라이언트가 고를 수 없고, 무엇으로 정렬됐는지 밝힌다. */
  sort: z.literal("publishedAt:desc,entryId:desc"),
});

/** 공개 목록 질의 — 07 §7.1. 여기 없는 파라미터는 무시되지 않고 거절된다. */
export const publicRegistryListQuery = z
  .object({
    q: z.string().trim().min(1).max(120).optional(),
    status: z.enum(["published", "revoked", "superseded"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * 공개 protocol 제안.
 *
 * 투표자 명단을 담지 않는다. 집계는 판정 근거이지만 명단은 아니며, 개별
 * 투표자는 subject이고 자연인 식별자로 이어진다(AC-32).
 *
 * 무게는 decimal string이다. `NUMERIC(78,0)`은 JSON number에 담기지 않는다
 * (ADR-T07 — 큰 정수를 number로 옮기면 조용히 반올림된다).
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

/** 제안 하나와 지나온 경로. 상태만 보면 정족수 미달과 취소가 같아 보인다. */
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
 * 공개 이력 사건.
 *
 * 여기서 새로 공개되는 것은 없다. `revoked`·`superseded` 공개 version은 이미
 * 상세 조회로 반환된다 — 다른 것은 "어느 기록에서" 대신 "언제 무슨 일이"로
 * 정렬한다는 점뿐이다.
 */
/**
 * 공개 이력의 사건 하나.
 *
 * **입도는 "일어났다 + 언제 + 어느 기록"이다**(결정, 2026-09-09).
 * 내용(사유·법적 근거·상세)과 당사자(행위자·요구 기관·제기자)는 담지 않는다.
 * 나중에 넓히는 것은 가능하지만 좁히는 것은 불가능하므로(05 §5.7) 좁은 쪽에서
 * 시작한다.
 *
 * `registryVersion`은 정정·철회에만 있다. suspension·pause·dispute는 registry
 * version이 아니라 전이·제한·이의 행이라 version이 없다 — `null`이 "이 종류에는
 * 그 값이 없다"를 말한다.
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
    /** 정정·철회에만 있다. 나머지는 null. */
    registryVersion: z
      .object({
        entryVersionId: z.string(),
        version: z.string(),
        supersededBy: z.string().nullable(),
        projection: publicProjection,
      })
      .strict()
      .nullable(),
    /** suspension에만 있다. 사유와 행위자는 담지 않는다. */
    lifecycle: z
      .object({ fromState: z.string(), toState: z.string() })
      .strict()
      .nullable(),
    /** pause·dispute가 끝난 시각. 아직 열려 있으면 null. */
    resolvedAt: isoDateTime.nullable(),
  })
  .strict();

export const publicDisclosureList = z.object({
  items: z.array(publicDisclosureEvent),
  nextCursor: z.string().nullable(),
  sort: z.literal("occurredAt:desc,eventId:desc"),
  /**
   * 이 목록이 **덮지 않는** 사건 종류.
   *
   * 빈 목록과 "그 종류는 애초에 여기 오지 않는다"를 구분하지 않으면 사용자가
   * "그런 일이 없었다"로 읽는다. 응답이 스스로 범위를 말한다.
   */
  notCovered: z.array(z.object({ kind: z.string(), reason: z.string() })),
});

/** 커서만 받는 공개 목록 질의. `q`가 없는 이유는 시계열이 검색 대상이 아니라서다. */
export const publicCursorQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * 공개 통합 검색.
 *
 * 0x로 시작하는 32바이트 hex는 hash(transaction·Merkle root·leaf·batch)로, 그 밖은
 * registry key 정확 일치와 이름·국가·광물 검색으로 본다. 지갑 주소는 받지 않는다 —
 * 공개 기록에 제출자 주소가 없어서 답할 수 없는 질문이다.
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
 * 내 활동.
 *
 * 이 지갑에 묶인 주체가 한 mutation의 감사 기록. **본인만 본다.** 역할이 필요
 * 없는 이유는 남의 기록이 아니라 자기가 한 일이기 때문이다. 요청 IP와 detail은
 * 내지 않는다 — 무엇을 했는지는 command·resource로 충분하다.
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

// --- 플랫폼 관리 -------------------------------------------

/**
 * 관리 화면이 보는 주체 하나.
 *
 * 지갑과 역할을 **함께** 낸다. 따로 조회하면 "역할은 있는데 붙은 지갑이 전부
 * 비활성"인 상태가 두 화면에 흩어져 보이지 않는다 — 그 상태가 곧 로그인할 수
 * 없는 계정이다.
 */
export const adminSubject = z.object({
  id: z.string(),
  displayName: z.string(),
  /** 사람인가 시스템 identity인가. 자격증명 관리가 다르다. */
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
  /** 로그인 가능한 지갑이 하나도 없는가. 화면이 그것을 먼저 말해야 한다. */
  locked: z.boolean(),
});

export const createSubjectRequest = z.object({
  displayName: z.string().min(1).max(200),
  /** 기본은 사람이다. `service`는 scan worker 같은 시스템 identity에만 쓴다. */
  kind: z.enum(["person", "service"]).default("person"),
});

export const bindWalletRequest = z.object({
  walletAddress: walletAddress,
  chainId: z.number().int().refine((value) => value === 56 || value === 97),
  assuranceLevel: z.enum(["wallet_only", "identity_bound", "high_assurance"]),
});

/**
 * 지갑 비활성 — AC-27.
 *
 * 사유 코드를 요구한다. 분실·침해·교체·퇴사는 같은 결과를 내지만 **과거 서명을
 * 어떻게 읽어야 하는지가 다르다.** 자유 문장만 받으면 그 구분이 남지 않는다.
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

/** 승인·반려. 제안자와 같은 사람이면 거절된다 — DB도 같은 것을 막는다. */
export const decideRoleGrantRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().min(1).max(1000),
});

// --- 워크스페이스 집계 ---------------------------------------

/**
 * Registry 게시 상태 한 줄.
 *
 * 지금까지 게시 상태는 프로젝트를 열어야만 보였다. 그러면 "이 tenant에서 무엇이
 * 게시됐나"에 답하려면 프로젝트를 하나씩 열어야 하고, 그것은 답이 아니다.
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
  /** 이 version이 anchor batch에 들어갔는가. 게시와 anchor는 다른 사건이다. */
  anchored: z.boolean(),
});

/**
 * My Work.
 *
 * 셋을 **의미로 갈라 낸다.** 한 목록에 섞으면 "내가 해야 하는 것"과 "내가 기다리는
 * 것"이 같아 보이고, 그 둘은 다음 행동이 정반대다.
 */
export const myWork = z.object({
  /** 나에게 배정된 검토. 내가 움직여야 끝난다. */
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
  /** 내가 시작했고 다른 사람의 결정을 기다리는 것. 내가 할 일은 없다. */
  waitingOnOthers: z.array(
    z.object({
      kind: z.literal("role_grant"),
      id: z.string(),
      summary: z.string(),
      since: isoDateTime,
    }),
  ),
  /** 아무에게도 배정되지 않았지만 열려 있는 것. 방치되면 아무도 모른다. */
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
 * 알림.
 *
 * `read`가 알림 자체의 속성이 아니라 **읽는 사람에 따라 달라지는 값**이다.
 * 역할로 간 알림은 여러 사람이 보며, 한 사람이 읽었다고 나머지에게서 사라지면
 * 그 사람이 처리하지 않았을 때 아무도 다시 보지 않는다.
 */
export const notification = z
  .object({
    id: z.string(),
    kind: z.enum(["review_assigned", "readiness_gap", "evidence_stale", "registry_revoked"]),
    /** 나에게 온 것인가, 내가 가진 역할에게 온 것인가. */
    audience: z.enum(["you", "role"]),
    audienceRole: z.string().nullable(),
    projectId: z.string().nullable(),
    summary: z.string(),
    /** 알림만 있고 갈 곳이 없으면 다시 찾아야 한다. */
    link: z.string(),
    occurredAt: isoDateTime,
    read: z.boolean(),
  })
  .strict();

/**
 * project lifecycle 전이 — 04 §4.3.
 *
 * `reason`이 필수다. 이유 없는 전이는 나중에 판단할 근거가 없다.
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
  /** `suspended`가 아니면 null. 복귀 대상이다(§4.3). */
  priorLifecycleState: z.string().nullable(),
  version: z.number().int().positive(),
  /**
   * 지나온 경로.
   *
   * 현재 상태만으로는 `suspended`에서 돌아온 프로젝트와 한 번도 멈춘 적 없는
   * 프로젝트가 같아 보인다.
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
 * 알림 수신처.
 *
 * **비밀을 반환하지 않는다.** `secretReference`는 참조이지 값이 아니지만, 그것도
 * 내지 않는다 — 참조가 `file:/run/secrets/x` 같은 경로를 드러내면 그 자체가
 * 배포 구조에 대한 정보다. 대신 설정돼 있는지만 낸다.
 */
export const notificationSink = z
  .object({
    id: z.string(),
    url: z.string(),
    state: z.enum(["active", "paused"]),
    hasSecret: z.boolean(),
    createdAt: isoDateTime,
    version: z.number().int().positive(),
    /** 이 수신처의 배달 상태. 보내지 못하고 있는 것을 화면이 말해야 한다. */
    delivery: z.object({
      pending: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
    }),
  })
  .strict();

export const createNotificationSinkRequest = z.object({
  // https만 받는다. 알림 본문에 프로젝트 식별자가 들어간다.
  url: z.string().regex(/^https:\/\/[^@\s]+$/, "https URL이어야 한다"),
  /** `file:`·`env:` 참조. 값을 직접 넣지 않는다(05 §5.12). */
  secretReference: z.string().min(1),
});

export const updateNotificationSinkRequest = z.object({
  state: z.enum(["active", "paused"]),
});
