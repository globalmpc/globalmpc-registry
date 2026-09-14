/**
 * Canonical source result enum — spec 04 §4.9 / 07 §7.11 / 13 §13.13.
 *
 * 정확히 12개다. API·event·UI·test fixture가 임의로 합치거나 별칭을 만들 수 없다.
 * 특히 `source_returned_no_record`(기록 없음), `not_applicable`(적용 대상 아님),
 * `source_unavailable`(출처 확인 불가)은 서로 다른 사실이며 같은 error code로
 * 반환하지 않는다(불변조건 16, AC-18).
 */
export const SOURCE_RESULTS = [
  "confirmed_from_source",
  "source_returned_no_record",
  "not_applicable",
  "access_not_authorized",
  "source_unavailable",
  "authentication_failed",
  "signature_invalid",
  "schema_changed",
  "stale",
  "conflicting",
  "manual_review_required",
  "legal_interpretation_required",
] as const;

export type SourceResult = (typeof SOURCE_RESULTS)[number];

/**
 * 사용자가 취할 수 있는 다음 행동 — spec 11 §11.11.
 *
 * UI는 이 값으로 CTA를 고르며 문구만 하드코딩하지 않는다(07 §7.3).
 */
export type NextAction =
  | "view_limitations"
  | "verify_query_or_manual_review"
  | "view_applicability_basis"
  | "check_authorization_process"
  | "view_retry_and_last_success"
  | "connection_admin_action"
  | "quarantine_security_review"
  | "await_reconciliation"
  | "request_refresh"
  | "compare_and_expert_review"
  | "submit_official_document"
  | "escalate_to_legal";

export interface SourceResultBehaviour {
  /** 같은 조건으로 재시도하면 다른 결과가 나올 수 있는가. */
  readonly retryable: boolean;
  /** 이 결과만으로 canonical claim acceptance가 가능한가 (불변조건 15). */
  readonly permitsCanonicalAcceptance: boolean;
  /** adapter 연결을 degraded로 볼 사유인가. */
  readonly degradesConnection: boolean;
  readonly nextAction: NextAction;
}

export const SOURCE_RESULT_BEHAVIOUR: Readonly<Record<SourceResult, SourceResultBehaviour>> = {
  // 출처가 조회 조건에 대해 응답했다. acceptance는 authority scope 검토 후 별도로 결정한다.
  confirmed_from_source: {
    retryable: false,
    permitsCanonicalAcceptance: true,
    degradesConnection: false,
    nextAction: "view_limitations",
  },
  // 출처는 정상 응답했고 "그런 기록이 없다"가 사실이다. 장애가 아니다.
  source_returned_no_record: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "verify_query_or_manual_review",
  },
  // 관할·프로젝트 조건상 이 요구가 적용되지 않는다. 결여가 아니다.
  not_applicable: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "view_applicability_basis",
  },
  access_not_authorized: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "check_authorization_process",
  },
  // 출처가 응답하지 못했다. 기록의 부재가 아니다.
  source_unavailable: {
    retryable: true,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "view_retry_and_last_success",
  },
  authentication_failed: {
    retryable: true,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "connection_admin_action",
  },
  signature_invalid: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "quarantine_security_review",
  },
  // silent coercion 금지 — ingestion을 멈추고 reconciliation을 만든다(AC-19).
  schema_changed: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "await_reconciliation",
  },
  stale: {
    retryable: true,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "request_refresh",
  },
  conflicting: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "compare_and_expert_review",
  },
  manual_review_required: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "submit_official_document",
  },
  legal_interpretation_required: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "escalate_to_legal",
  },
};

export function isSourceResult(value: string): value is SourceResult {
  return (SOURCE_RESULTS as readonly string[]).includes(value);
}

/**
 * 수집 방법 — API 성공만이 유일한 경로가 아니다(OD-42, AC-29).
 *
 * `manual`은 collection method이지 connection lifecycle 상태도 source result도
 * 아니다(§4.9).
 */
export const COLLECTION_METHODS = [
  "authenticated_api",
  "official_bulk_export",
  "verifiable_signed_document",
  "manual_official_registry_confirmation",
] as const;

export type CollectionMethod = (typeof COLLECTION_METHODS)[number];
