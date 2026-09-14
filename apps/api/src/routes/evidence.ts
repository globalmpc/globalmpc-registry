import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import {
  checkChannelReady,
  detectSchemaDrift,
  SOURCE_RESULTS,
  SOURCE_RESULT_BEHAVIOUR,
  computeClaimGrade,
  type AttestationType,
  type EvidenceTier,
  type SourceResult,
  type VerificationState,
} from "@mpc/domain";
import { badRequest, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { resolveSecret } from "@mpc/config";
import type { ObjectStore } from "@mpc/storage";
import {
  BULK_EXTRACTOR_VERSION,
  extractObservedFields,
  SIGNATURE_VERIFIER_VERSION,
  verifyDetachedSignature,
} from "../services/source-verification.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Source Receipt와 Claim — spec 05 §5.12, 07 §7.11.
 *
 * 이 두 리소스가 증빙 lifecycle의 입구다. 여기서 지키는 것:
 *
 * - receipt의 12개 result는 `SOURCE_RESULT_BEHAVIOUR`가 소유한다. 라우트가
 *   `retryable`을 직접 판단하지 않는다.
 * - API secret은 저장하지 않는다. connection의 `secret_reference`만 참조한다.
 * - claim의 수치는 decimal string이다. number를 받으면 거절한다.
 * - grade는 `computeClaimGrade`가 계산한다. 라우트에 등급 규칙을 쓰지 않는다.
 */

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, "32바이트 소문자 hex여야 한다");

/**
 * 인증 **방식**의 유한 목록 — 05 §5.12.
 *
 * 자유 문자열로 두면 `"bearer sk-live-..."` 같은 값이 그대로 저장된다.
 * "API secret·token·private key는 저장하지 않고 secret reference만 기록한다"는
 * 요구를 지키려면 방식 자체를 enum으로 고정해야 한다. 실제 자격증명은
 * `source_connections.secret_reference`가 가리키는 곳에만 있다.
 */
const AUTHENTICATION_METHODS = [
  "mtls",
  "oauth2",
  "mtls+oauth2",
  "api_key_reference",
  "signed_document",
  "official_seal",
  "manual_verification",
  "none",
] as const;

const createReceiptSchema = z.object({
  connectionId: z.string().uuid(),
  authorityId: z.string().uuid(),
  result: z.enum(SOURCE_RESULTS),
  collectionMethod: z.enum([
    "authenticated_api",
    "official_bulk_export",
    "verifiable_signed_document",
    "manual_official_registry_confirmation",
  ]),
  queryBasis: z.record(z.string()),
  endpointOrDocumentRef: z.string().min(1),
  authenticationMethod: z.enum(AUTHENTICATION_METHODS),
  rawHash: hex32,
  sourceSchemaVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  normalizationVersion: z.string().nullable().default(null),
  termsLicense: z.string().min(1),
  commercialReuse: z.enum(["confirmed", "unconfirmed", "prohibited"]),
  disclosurePermission: z.enum(["public", "restricted", "confidential", "pii", "whistleblower"]),
  asOf: z.string().datetime(),
  effectiveAt: z.string().datetime().nullable().default(null),
  freshnessStatus: z.enum(["fresh", "aging", "stale", "unknown"]),
  /**
   * 채널별 증거의 **입력** — AC-29, 2026-09-10 실사 A1.
   *
   * 예전에는 여기서 `signatureValid`·`observedFields`를 **결과로** 받았다.
   * 그러면 확정의 근거가 요청자의 진술이 된다. 지금은 검증할 **대상**만 받고
   * 결과는 서버가 만든다.
   *
   * - `documentUploadId` — 이미 올라온 파일. 같은 프로젝트여야 하고 검사를
   *   통과해 있어야 한다.
   * - `signatureBase64` — 그 문서에 대한 분리 서명. 공개키는 연동이 갖는다.
   */
  documentUploadId: z.string().uuid().nullable().default(null),
  signatureBase64: z.string().min(1).nullable().default(null),
  limitations: z.array(z.string()).default([]),
});

/**
 * decimal string. `05 §5.9`가 요구하는 "원 단위와 기준일 보존"을 위해 number를
 * 받지 않는다. 부동소수점으로 왕복하면 값이 바뀐다.
 */
const decimalString = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, "수치는 decimal string이어야 한다");

const createClaimSchema = z
  .object({
    claimType: z.string().min(1),
    valueText: z.union([decimalString, z.string().min(1)]),
    unit: z.string().nullable().default(null),
    asOf: z.string().date().nullable().default(null),
    sourceCoordinate: z.record(z.string()),
    /**
     * 이 값이 나온 Source Receipt — AC-04·AC-21.
     *
     * `sourceCoordinate`는 문서 안의 위치이지 어느 조회에서 나왔는지가 아니다.
     * 이 참조가 없으면 출처가 취소돼도 그 출처에서 나온 claim을 찾을 수 없다.
     *
     * nullable인 이유: 사람이 직접 입력하는 경로가 남아 있다. **없는 것을 있다고
     * 채우지 않는다** — 대신 `core.claims_without_evidence`가 그것을 드러낸다.
     */
    sourceReceiptId: z.string().uuid().nullable().default(null),
    evidenceTier: z.enum(["P1", "P2", "P3", "P4", "P5"]).nullable().default(null),
    verificationState: z
      .enum([
        "unreviewed",
        "machine_checked",
        "analyst_checked",
        "independently_assured",
        "rejected",
      ])
      .default("unreviewed"),
    attestationTypes: z
      .array(
        z.enum([
          "professional_signoff",
          "laboratory_accreditation",
          "independent_assurance",
          "legal_notarization",
          "cryptographic_attestation",
        ]),
      )
      .default([]),
  })
  .superRefine((value, ctx) => {
    // 수치형 claim은 단위 없이 저장할 수 없다. 단위 없는 수치는 나중에
    // 어떤 값이었는지 복원할 수 없다.
    const isNumeric = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value.valueText);
    if (isNumeric && (value.unit === null || value.unit.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: "수치 claim에는 단위가 필요하다",
      });
    }
  });

interface ReceiptRow {
  id: string;
  project_id: string | null;
  connection_id: string;
  authority_id: string;
  collection_method: string;
  result: SourceResult;
  raw_hash: string;
  source_schema_version: string;
  adapter_version: string;
  terms_license: string;
  commercial_reuse: string;
  received_at: Date;
  as_of: Date;
  effective_at: Date | null;
  freshness_status: string;
  correlation_id: string;
  limitations: string[];
}

function toReceiptView(row: ReceiptRow, requestId: string, asOf: string) {
  const behaviour = SOURCE_RESULT_BEHAVIOUR[row.result];
  return {
    id: row.id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    authorityId: row.authority_id,
    collectionMethod: row.collection_method,
    result: row.result,
    // 12개 result의 의미는 도메인이 소유한다. 라우트가 재해석하지 않는다.
    retryable: behaviour.retryable,
    nextAction: behaviour.nextAction,
    permitsCanonicalAcceptance: behaviour.permitsCanonicalAcceptance,
    rawHash: row.raw_hash,
    sourceSchemaVersion: row.source_schema_version,
    adapterVersion: row.adapter_version,
    termsLicense: row.terms_license,
    commercialReuse: row.commercial_reuse,
    receivedAt: row.received_at.toISOString(),
    asOf: row.as_of.toISOString(),
    effectiveAt: row.effective_at?.toISOString() ?? null,
    freshnessStatus: row.freshness_status,
    correlationId: row.correlation_id,
    limitations: row.limitations,
    requestId,
    responseAsOf: asOf,
  };
}

interface ClaimRow {
  id: string;
  project_id: string;
  claim_type: string;
  value_text: string;
  unit: string | null;
  as_of: Date | null;
  source_coordinate: Record<string, string>;
  evidence_tier: EvidenceTier | null;
  verification_state: VerificationState;
  grade: string;
  excluded_by_rule: boolean;
  source_receipt_id: string | null;
  stale_since: Date | null;
  stale_reason: string | null;
  version: number;
}

function toClaimView(row: ClaimRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    projectId: row.project_id,
    claimType: row.claim_type,
    valueText: row.value_text,
    unit: row.unit,
    asOf: row.as_of ? row.as_of.toISOString().slice(0, 10) : null,
    sourceCoordinate: row.source_coordinate,
    evidenceTier: row.evidence_tier,
    verificationState: row.verification_state,
    grade: row.grade,
    excludedByRule: row.excluded_by_rule,
    /**
     * 근거와 그 상태 — AC-04·AC-21.
     *
     * `null`은 "근거 없음"이며 숨기지 않는다. `stale`은 검토가 없었다는 뜻이
     * 아니라 그 검토가 딛고 있던 근거가 흔들렸다는 뜻이다 — 그래서
     * `verificationState`와 따로 보여준다.
     */
    sourceReceiptId: row.source_receipt_id,
    stale: row.stale_since !== null,
    staleSince: row.stale_since?.toISOString() ?? null,
    staleReason: row.stale_reason,
    version: row.version,
    requestId,
    responseAsOf: asOf,
  };
}

/** claim의 attestation·conflict 상태에서 grade를 다시 계산한다. */
async function recomputeGrade(
  tx: postgres.TransactionSql,
  claimId: string,
): Promise<string> {
  const [claim] = await tx<
    {
      evidence_tier: EvidenceTier | null;
      verification_state: VerificationState;
      excluded_by_rule: boolean;
    }[]
  >`
    SELECT evidence_tier, verification_state, excluded_by_rule
    FROM core.claims WHERE id = ${claimId}
  `;
  if (!claim) throw notFound("claim을 찾을 수 없다");

  const attestations = await tx<{ attestation_type: AttestationType }[]>`
    SELECT DISTINCT a.attestation_type
    FROM core.verification_attestations a
    WHERE ${claimId}::uuid = ANY(a.claim_scope) AND a.state IN ('signed', 'active')
  `;

  const [conflicts] = await tx<{ count: string }[]>`
    SELECT count(*)::text AS count FROM core.claim_conflicts
    WHERE claim_id = ${claimId} AND resolved_at IS NULL
  `;

  const grade = computeClaimGrade({
    verificationState: claim.verification_state,
    evidenceTier: claim.evidence_tier,
    attestationTypes: attestations.map((row) => row.attestation_type),
    unresolvedConflictCount: Number(conflicts?.count ?? "0"),
    excludedByRule: claim.excluded_by_rule,
  });

  await tx`UPDATE core.claims SET grade = ${grade}, version = version + 1 WHERE id = ${claimId}`;
  return grade;
}

/**
 * claim이 속한 프로젝트.
 *
 * 인가는 멱등 블록 **밖에서** 한다. replay는 저장된 응답을 그대로 돌려주므로,
 * 안에 두면 남의 key를 재생한 요청이 인가를 지나지 않는다.
 */
async function claimProjectId(
  sql: postgres.Sql,
  tenantId: string,
  claimId: string,
): Promise<string> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`SELECT project_id FROM core.claims WHERE id = ${claimId}`,
  );
  if (!row) throw notFound("claim을 찾을 수 없다");
  return row.project_id;
}

/**
 * 확정 근거를 서버가 만든다 — 2026-09-10 실사 A1.
 *
 * 네 채널이 확정될 수 있는 조건이 각각 다르고, **어느 것도 요청 본문의 주장으로
 * 충족되지 않는다.**
 *
 * - `authenticated_api` — 서버가 출처를 부른 경로(`/collect`)에서만 확정된다.
 * - `verifiable_signed_document` — 업로드된 바이트를 연동의 공개키로 검증한다.
 * - `official_bulk_export` — 업로드된 파일에서 필드를 직접 뽑아 대조한다.
 * - `manual_official_registry_confirmation` — 다른 사람의 두 번째 검토.
 */
interface ConfirmationEvidence {
  readonly channelEvidence: Record<string, unknown>;
  /** 원문 해시를 문서에 결속한다. 요청자가 보낸 값을 쓰지 않는다. */
  readonly rawHash: string | null;
}

interface UploadForVerification {
  readonly id: string;
  readonly object_key: string;
  readonly content_hash: string;
  readonly content_type: string;
  readonly byte_size: string;
  readonly state: string;
}

/** 확정 근거로 쓸 수 있는 업로드 상태. 검사 전 파일은 근거가 아니다. */
const VERIFIABLE_UPLOAD_STATES = new Set(["scanned_clean", "promoted"]);

async function loadVerifiableUpload(
  tx: postgres.TransactionSql,
  projectId: string,
  uploadId: string,
): Promise<UploadForVerification> {
  const [upload] = await tx<UploadForVerification[]>`
    SELECT id, object_key, content_hash, content_type, byte_size, state::text AS state
    FROM core.object_uploads
    WHERE id = ${uploadId} AND project_id = ${projectId}
  `;
  if (!upload) throw notFound("업로드를 찾을 수 없다");

  if (!VERIFIABLE_UPLOAD_STATES.has(upload.state)) {
    // 검사를 지나지 않은 파일을 확정 근거로 쓰면 quarantine이 형식만 남는다.
    throw unprocessable(
      "UPLOAD_NOT_VERIFIABLE",
      "검사를 통과하지 않은 업로드는 확정 근거가 될 수 없다",
      { state: upload.state, nextAction: "검사가 끝난 뒤에 다시 시도한다" },
    );
  }
  return upload;
}

async function readUploadBytes(
  store: ObjectStore,
  upload: UploadForVerification,
): Promise<Uint8Array> {
  const bytes = await store.get(upload.object_key);
  if (!bytes) {
    // DB에는 있는데 객체가 없다. 확정하지 않는다 — 그 상태가 곧 A5의 형태다.
    throw unprocessable("UPLOAD_OBJECT_MISSING", "업로드된 원문을 저장소에서 찾지 못했다", {
      nextAction: "백업 복구 상태를 확인하고 파일을 다시 올린다",
    });
  }
  return bytes;
}

/**
 * 채널별 확정 근거를 만든다.
 *
 * 실패는 전부 422다 — 요청은 형식상 올바르고, **근거가 요건을 채우지 못한
 * 것**이다. 어느 쪽이든 `nextAction`으로 무엇을 더 해야 하는지 말한다.
 */
async function buildConfirmationEvidence(
  tx: postgres.TransactionSql,
  input: {
    readonly store: ObjectStore;
    readonly projectId: string;
    readonly connectionId: string;
    readonly collectionMethod: string;
    readonly documentUploadId: string | null;
    readonly signatureBase64: string | null;
    readonly subjectId: string | null;
  },
): Promise<ConfirmationEvidence> {
  switch (input.collectionMethod) {
    /**
     * API 수집은 서버가 부른 경로에서만 확정된다.
     *
     * 이 route는 사람이 결과를 적어 넣는 입구다. 여기서 `authenticated_api`를
     * 확정할 수 있으면 **호출하지 않고 "호출해서 확인했다"를 기록**할 수 있다.
     * 그 기록은 `/collect`가 만든 것과 구분되지 않는다.
     */
    case "authenticated_api":
      throw unprocessable(
        "CONFIRMATION_REQUIRES_SERVER_COLLECTION",
        "API 수집의 확정은 서버 조회 경로에서만 만들어진다",
        {
          nextAction:
            "POST /api/v1/source-connections/{connectionId}/collect 로 조회한다. " +
            "자동 호출 대상이 아니면 수동 확인 경로를 쓴다",
        },
      );

    case "verifiable_signed_document":
      return verifySignedDocumentEvidence(tx, input);

    case "official_bulk_export":
      return extractBulkEvidence(tx, input);

    // 수동 확인은 서명도 파일도 없다. 두 번째 검토가 유일한 근거이며 그것은
    // 별도 route에서 다른 사람이 만든다 — 여기서는 만들 수 없다.
    default:
      return { channelEvidence: {}, rawHash: null };
  }
}

async function verifySignedDocumentEvidence(
  tx: postgres.TransactionSql,
  input: {
    readonly store: ObjectStore;
    readonly projectId: string;
    readonly connectionId: string;
    readonly documentUploadId: string | null;
    readonly signatureBase64: string | null;
  },
): Promise<ConfirmationEvidence> {
  if (!input.documentUploadId || !input.signatureBase64) {
    throw unprocessable(
      "SIGNATURE_EVIDENCE_MISSING",
      "서명 문서는 문서와 분리 서명 없이 확정될 수 없다",
      { nextAction: "documentUploadId와 signatureBase64를 함께 보낸다" },
    );
  }

  const [connection] = await tx<{ connection_key: string; signing_key_reference: string | null }[]>`
    SELECT connection_key, signing_key_reference FROM core.source_connections
    WHERE id = ${input.connectionId}
  `;
  if (!connection) throw notFound("연동을 찾을 수 없다");

  /**
   * **서명자를 아는 것과 서명이 유효한 것은 다르다.**
   *
   * 등록된 공개키가 없으면 유효한 서명이라도 그것이 누구의 것인지 말할 수
   * 없다. 그 상태에서 확정하면 아무나 만든 서명이 출처 확인이 된다.
   */
  if (!connection.signing_key_reference) {
    throw unprocessable(
      "SIGNER_KEY_NOT_REGISTERED",
      "이 연동에는 등록된 서명자 공개키가 없다",
      {
        connectionKey: connection.connection_key,
        nextAction: "기관의 공개키를 연동의 signing_key_reference에 등록한다",
      },
    );
  }

  let publicKeyPem: string;
  try {
    publicKeyPem = resolveSecret(connection.connection_key, connection.signing_key_reference);
  } catch (error) {
    // 참조 해석 실패 메시지에는 경로·환경변수 이름이 들어갈 수 있다.
    throw unprocessable("SIGNER_KEY_UNAVAILABLE", "등록된 공개키를 읽지 못했다", {
      connectionKey: connection.connection_key,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const upload = await loadVerifiableUpload(tx, input.projectId, input.documentUploadId);
  const bytes = await readUploadBytes(input.store, upload);

  const check = verifyDetachedSignature({
    bytes,
    signature: new Uint8Array(Buffer.from(input.signatureBase64, "base64")),
    publicKeyPem,
  });

  if (!check.ok) {
    throw unprocessable("SIGNATURE_NOT_VERIFIED", check.reason, {
      nextAction: check.nextAction,
      signatureValid: String(check.signatureValid),
    });
  }

  return {
    /**
     * 무엇에 결속된 확정인가.
     *
     * 문서 해시·검증기 버전·키 참조가 함께 남는다. 셋 중 하나라도 없으면
     * 나중에 "그때 무엇을 무슨 규칙으로 확인했나"에 답할 수 없다.
     */
    channelEvidence: {
      signatureValid: true,
      signerRecognized: true,
      documentUploadId: upload.id,
      documentHash: upload.content_hash,
      signingKeyReference: connection.signing_key_reference,
      keyType: check.keyType,
      signatureAlgorithm: check.algorithm ?? "eddsa",
      verifierVersion: SIGNATURE_VERIFIER_VERSION,
      verifiedBy: "server",
    },
    rawHash: upload.content_hash,
  };
}

async function extractBulkEvidence(
  tx: postgres.TransactionSql,
  input: {
    readonly store: ObjectStore;
    readonly projectId: string;
    readonly connectionId: string;
    readonly documentUploadId: string | null;
  },
): Promise<ConfirmationEvidence> {
  if (!input.documentUploadId) {
    throw unprocessable(
      "BULK_FILE_MISSING",
      "bulk export는 파일 없이 확정될 수 없다",
      { nextAction: "출처가 내려준 파일을 올리고 documentUploadId를 보낸다" },
    );
  }

  const upload = await loadVerifiableUpload(tx, input.projectId, input.documentUploadId);
  const bytes = await readUploadBytes(input.store, upload);

  // **파일에서 직접 뽑는다.** 요청자가 보낸 목록을 쓰면 대조하는 시늉만 한다.
  const extraction = extractObservedFields(bytes, upload.content_type);
  if (!extraction.ok) {
    throw unprocessable("BULK_SCHEMA_UNREADABLE", extraction.reason, {
      nextAction: extraction.nextAction,
      contentType: upload.content_type,
    });
  }

  const [connection] = await tx<{ schema_fingerprint: string[] | null }[]>`
    SELECT schema_fingerprint FROM core.source_connections WHERE id = ${input.connectionId}
  `;
  const drift = detectSchemaDrift(connection?.schema_fingerprint ?? [], extraction.fields);

  if (drift.drifted) {
    throw unprocessable("SOURCE_SCHEMA_DRIFT", "선언된 스키마와 다른 파일은 확정될 수 없다", {
      added: drift.added.join(", "),
      removed: drift.removed.join(", "),
      nextAction: "스키마 변경을 확인하고 연동의 schema_fingerprint를 갱신한다",
    });
  }

  // 선언이 없으면 대조가 일어나지 않았다. `checkChannelReady`도 같은 것을
  // 막지만, 여기서 먼저 말해야 무엇을 등록해야 하는지 알 수 있다.
  if (!drift.compared) {
    throw unprocessable(
      "SOURCE_SCHEMA_NOT_DECLARED",
      "연동에 선언된 스키마가 없어 파일을 대조할 수 없다",
      { nextAction: "연동의 schema_fingerprint에 기대 컬럼을 등록한다" },
    );
  }

  return {
    channelEvidence: {
      observedFields: extraction.fields,
      schemaDrift: drift,
      documentUploadId: upload.id,
      documentHash: upload.content_hash,
      extractorVersion: BULK_EXTRACTOR_VERSION,
      verifiedBy: "server",
    },
    rawHash: upload.content_hash,
  };
}

export async function registerEvidenceRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  store: ObjectStore,
): Promise<void> {
  // --- Source Receipt ------------------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/source-receipts",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<ReceiptRow[]>`
          SELECT * FROM core.source_receipts
          WHERE project_id = ${request.params.projectId}
          ORDER BY as_of DESC LIMIT 100
        `,
      );

      return {
        items: rows.map((row) =>
          toReceiptView(row, request.context.requestId, request.context.asOf),
        ),
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/source-receipts",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createReceiptSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const id = randomUUID();
          const data = parsed.data;

          /**
           * 확정 근거를 서버가 만든다 — AC-29, 2026-09-10 실사 A1.
           *
           * 확정이 아닌 결과는 여기를 지나지 않는다. **실패는 실패대로 남아야
           * 한다** — 남기지 않으면 다음 사람이 같은 시도를 반복한다.
           */
          const evidence = data.result === "confirmed_from_source"
            ? await buildConfirmationEvidence(tx, {
                store,
                projectId: request.params.projectId,
                connectionId: data.connectionId,
                collectionMethod: data.collectionMethod,
                documentUploadId: data.documentUploadId,
                signatureBase64: data.signatureBase64,
                subjectId: session.subjectId ?? null,
              })
            : ({ channelEvidence: {}, rawHash: null } satisfies ConfirmationEvidence);

          /**
           * 도메인 판정을 한 번 더 지난다.
           *
           * 위에서 만든 값으로 부른다 — 요청 본문이 아니다. DB CHECK가 같은
           * 것을 막지만 거기서 걸리면 500이 나가고, 보내는 쪽은 **무엇을 더
           * 해야 하는지** 알 수 없다.
           */
          const ready = checkChannelReady({
            method: data.collectionMethod,
            result: data.result,
            signatureValid:
              (evidence.channelEvidence["signatureValid"] as boolean | undefined) ?? null,
            observedFields:
              (evidence.channelEvidence["observedFields"] as string[] | undefined) ?? null,
            // 수동 확인은 만들 때 두 번째 검토자가 있을 수 없다. 별도 route에서
            // 다른 사람이 확인한 뒤에 확정된다.
            firstConfirmedBy: session.subjectId,
            secondConfirmedBy: null,
          });
          if (!ready.ok) {
            throw unprocessable("CHANNEL_REQUIREMENT_UNMET", ready.reason, {
              collectionMethod: data.collectionMethod,
              nextAction: ready.nextAction,
            });
          }

          const channelEvidence = evidence.channelEvidence;
          /**
           * 원문 해시를 문서에 결속한다.
           *
           * 요청자가 보낸 `rawHash`는 확정 경로에서 쓰이지 않는다 — 그 값이
           * 문서와 무관하면 "이 해시의 원문을 다시 받아 대조한다"가 성립하지
           * 않는다.
           */
          const rawHash = evidence.rawHash ?? data.rawHash;

          const [receipt] = await tx<ReceiptRow[]>`
            INSERT INTO core.source_receipts (
              id, tenant_id, project_id, connection_id, authority_id, collection_method,
              result, query_basis, endpoint_or_document_ref, authentication_method,
              raw_hash, source_schema_version, adapter_version, normalization_version,
              terms_license, commercial_reuse, disclosure_permission,
              received_at, as_of, effective_at, freshness_status, correlation_id, limitations,
              channel_evidence, first_confirmed_by
            ) VALUES (
              ${id}, ${tenantId}, ${request.params.projectId}, ${data.connectionId},
              ${data.authorityId}, ${data.collectionMethod}, ${data.result},
              ${tx.json(data.queryBasis)}, ${data.endpointOrDocumentRef},
              ${data.authenticationMethod}, ${rawHash}, ${data.sourceSchemaVersion},
              ${data.adapterVersion}, ${data.normalizationVersion}, ${data.termsLicense},
              ${data.commercialReuse}, ${data.disclosurePermission},
              now(), ${data.asOf}, ${data.effectiveAt}, ${data.freshnessStatus},
              ${correlationId}, ${data.limitations},
              ${tx.json(channelEvidence as never)}, ${session.subjectId}
            )
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "source_receipt.received",
            resourceType: "source_receipt",
            resourceId: id,
            correlationId,
            requestIp: request.ip,
            // result는 감사에 남긴다. 어떤 결과였는지가 나중에 재현 대상이다.
            detail: { result: data.result, collectionMethod: data.collectionMethod },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "source_receipt.received",
            aggregateId: id,
            aggregateVersion: 1,
            projectId: request.params.projectId,
            payload: { result: data.result, authorityId: data.authorityId },
            correlationId,
          });

          return toReceiptView(receipt!, requestId, asOf);
        }),
      );
    },
  );

  // --- Claim ---------------------------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/claims",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<ClaimRow[]>`
          SELECT * FROM core.claims
          WHERE project_id = ${request.params.projectId}
          ORDER BY claim_type LIMIT 200
        `,
      );

      return {
        items: rows.map((row) => toClaimView(row, request.context.requestId, request.context.asOf)),
        requestId: request.context.requestId,
        asOf: request.context.asOf,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/claims",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createClaimSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const id = randomUUID();
          const data = parsed.data;

          // grade는 도메인 규칙이 계산한다.
          const grade = computeClaimGrade({
            verificationState: data.verificationState,
            evidenceTier: data.evidenceTier,
            attestationTypes: data.attestationTypes,
            unresolvedConflictCount: 0,
            excludedByRule: false,
          });

          const [claim] = await tx<ClaimRow[]>`
            INSERT INTO core.claims (
              id, tenant_id, project_id, claim_type, value_text, unit, as_of,
              source_coordinate, evidence_tier, verification_state, grade,
              source_receipt_id
            ) VALUES (
              ${id}, ${tenantId}, ${request.params.projectId}, ${data.claimType},
              ${data.valueText}, ${data.unit}, ${data.asOf},
              ${tx.json(data.sourceCoordinate)}, ${data.evidenceTier},
              ${data.verificationState}, ${grade}, ${data.sourceReceiptId}
            )
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "claim.created",
            resourceType: "claim",
            resourceId: id,
            afterVersion: 1,
            correlationId,
            requestIp: request.ip,
            detail: { claimType: data.claimType, grade },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "provenance.grade.changed",
            aggregateId: id,
            aggregateVersion: 1,
            projectId: request.params.projectId,
            payload: { claimType: data.claimType, grade },
            correlationId,
          });

          return toClaimView(claim!, requestId, asOf);
        }),
      );
    },
  );

  app.post<{ Params: { claimId: string } }>(
    "/api/v1/claims/:claimId/conflicts",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // conflict를 기록하면 grade가 재계산되어 claim의 version이 올라간다.
      // 두 사람이 같은 claim에 동시에 기록하면 한쪽의 판단이 흔적 없이 덮인다.
      const expectedVersion = requireIfMatch(request);

      const parsed = z
        .object({ conflictType: z.string().min(1) })
        .safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다");
      }

      const effectiveRole = assertAuthorized(
        session,
        "claim.curate",
        projectResource(tenantId, await claimProjectId(sql, tenantId, request.params.claimId)),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          // 행을 잠근 뒤 버전을 본다. 잠그지 않으면 확인과 갱신 사이에 다른
          // 트랜잭션이 끼어들어 검사가 무의미해진다.
          const [current] = await tx<{ version: number }[]>`
            SELECT version FROM core.claims
            WHERE id = ${request.params.claimId}
            FOR UPDATE
          `;
          if (!current) throw notFound("claim을 찾을 수 없다");
          assertVersionMatches(expectedVersion, current.version, "claim");

          await tx`
            INSERT INTO core.claim_conflicts (id, tenant_id, claim_id, conflict_type)
            VALUES (${randomUUID()}, ${tenantId}, ${request.params.claimId}, ${parsed.data.conflictType})
          `;

          // conflict가 생기면 grade가 내려갈 수 있다. 즉시 재계산한다 —
          // 낡은 grade가 readiness 입력이 되면 안 된다.
          const grade = await recomputeGrade(tx, request.params.claimId);

          const [claim] = await tx<ClaimRow[]>`
            SELECT * FROM core.claims WHERE id = ${request.params.claimId}
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "claim.conflict.recorded",
            resourceType: "claim",
            resourceId: request.params.claimId,
            correlationId,
            requestIp: request.ip,
            detail: { conflictType: parsed.data.conflictType, grade },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "provenance.grade.changed",
            aggregateId: request.params.claimId,
            aggregateVersion: claim!.version,
            payload: { grade, reason: "conflict_recorded" },
            correlationId,
          });

          return toClaimView(claim!, requestId, asOf);
        }),
      );
    },
  );
}
