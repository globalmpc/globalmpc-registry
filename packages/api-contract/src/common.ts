import { z } from "zod";
import { SOURCE_RESULTS } from "@mpc/domain";

/**
 * 공통 API 규약 — spec 07 §7.1·§7.3.
 *
 * 여기 정의된 것들이 모든 응답에 붙는다. 특히 `limitations`·`legalEffect`·
 * `disclaimerCodes`는 선택 항목이 아니다 — UI가 경고를 렌더링할 근거이며,
 * 문구를 하드코딩하지 않기 위한 구조다(§7.3).
 */

export const hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "32바이트 소문자 hex여야 한다");

export const walletAddress = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "20바이트 소문자 hex 주소여야 한다");

export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID여야 한다");

export const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "ISO 8601 UTC여야 한다");

/**
 * 오류 envelope.
 *
 * `retryable`이 있는 이유: 07 §7.11이 `source_returned_no_record`와 timeout을
 * 같은 error code로 반환하지 못하게 한다. 클라이언트가 재시도 여부를 추측하면
 * "기록 없음"을 장애로 오인한다.
 */
export const errorEnvelope = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  retryable: z.boolean(),
  correlationId: z.string(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelope>;

/** 모든 응답에 붙는 메타(§7.1). */
export const responseMeta = z.object({
  requestId: z.string(),
  resourceVersion: z.number().int().nonnegative().optional(),
  asOf: isoDateTime,
});

/**
 * 안전 필드 — §7.3.
 *
 * `legalEffect`가 `none`과 `counsel_required` 둘뿐인 것이 의도다. MPC API는
 * 법률 효력의 존재를 판정하지 않는다.
 */
export const safetyFields = z.object({
  authority: z.string().describe("이 값을 산출·결정한 주체"),
  basisVersion: z.string(),
  ruleVersion: z.string().nullable(),
  limitations: z.array(z.string()),
  sourceAge: z.string().nullable().describe("경과일. 정수 decimal string"),
  staleStatus: z.enum(["fresh", "aging", "stale", "unknown"]),
  verificationScope: z.array(z.string()),
  legalEffect: z.enum(["none", "counsel_required"]),
  externalRegulatedServiceStatus: z
    .object({
      status: z.enum([
        "not_linked",
        "requested",
        "ersp_confirmed",
        "ersp_rejected",
        "expired",
      ]),
      erspOrganizationId: z.string().nullable(),
      authorizationEvidenceId: z.string().nullable(),
      asOf: isoDateTime.nullable(),
      limitations: z.array(z.string()),
    })
    .nullable(),
  disclaimerCodes: z.array(z.string()),
});

export const sourceResultEnum = z.enum(SOURCE_RESULTS);

/** 12개 result의 UI·재시도 힌트(§7.11, §11.11). */
export const sourceStatusView = z.object({
  result: sourceResultEnum,
  retryable: z.boolean(),
  nextAction: z.string(),
  lastSuccessAt: isoDateTime.nullable(),
  asOf: isoDateTime,
  authorityReference: z.string(),
  authorityScope: z.array(z.string()),
  collectionMethod: z.enum([
    "authenticated_api",
    "official_bulk_export",
    "verifiable_signed_document",
    "manual_official_registry_confirmation",
  ]),
  adapterVersion: z.string(),
  sourceSchemaVersion: z.string(),
  limitations: z.array(z.string()),
});

/** mutation 공통 헤더(§7.1). */
export const mutationHeaders = z.object({
  "idempotency-key": z.string().min(16).describe("mutation 재시도 시 중복 실행을 막는다"),
  "if-match": z.string().optional().describe('versioned resource mutation에 필수. `"<version>"` 형식'),
});

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
