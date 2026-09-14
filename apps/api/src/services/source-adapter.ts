import { createHash } from "node:crypto";
import {
  assertEndpointReachable,
  dnsResolver,
  type HostResolver,
} from "./source-endpoint.js";
import {
  pinnedFetch,
  SourceResponseTooLargeError,
  type SourceFetch,
} from "./source-fetch.js";
import {
  checkAdapterAvailable,
  toReceiptInput,
  type AdapterDescriptor,
  type AdapterInvocation,
  type SourceResult,
} from "@mpc/domain";

/**
 * Source Adapter 구현 — spec 05 §5.12, OD-42.
 *
 * 프레임워크(`@mpc/domain/adapter`)가 규칙을 정하고 여기서 실제 호출을 한다.
 * **기관 이름이 이 파일에 없다** — 어떤 기관을 어떤 방식으로 부를지는 설정으로
 * 온다(OD-43).
 *
 * 두 가지 수집 방식만 구현한다.
 *
 * - `http` — 인증된 API. 응답 상태와 본문으로 12개 결과 중 하나를 정한다.
 * - `manual` — 사람이 조회한 결과를 받는다. adapter를 부르지 않는다.
 *
 * 나머지(bulk export, 서명 문서)는 실제 대상이 확인된 뒤에 만든다. 지금 만들면
 * 쓰지 않는 코드가 유지 대상이 된다.
 */

export interface HttpAdapterConfig {
  readonly endpoint: string;
  /** 인증 헤더. 값은 secret manager에서 온다 — 여기에 저장하지 않는다. */
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** 응답에서 기준일을 꺼낼 JSON 경로. 없으면 null이다. */
  readonly effectiveAtField: string | null;
  /** 이 출처의 응답이 어떻게 생겼는가. 선언이 없으면 확정하지 않는다. */
  readonly responseProfile: ResponseProfile;
}

/**
 * 출처 응답 profile — 2026-09-10 실사 A7.
 *
 * 이전에는 **JSON 파싱이 되면 스키마가 맞는 것으로 봤다.** 그래서 HTTP 200에
 * `{"error":"unavailable"}`이나 `{}`가 와도 `confirmed_from_source`가 됐다 —
 * 출처가 "답할 수 없다"고 말한 것을 확인으로 기록하는 경로다.
 *
 * 선언은 연동(`core.source_connections`)이 갖는다. **코드에 기관이 없다**(OD-43).
 */
export interface ResponseProfile {
  /**
   * 정상 응답이 반드시 갖는 최상위 필드.
   *
   * **비어 있으면 확정하지 않는다.** 모르는 형식을 일치로 읽지 않는다 —
   * `official_bulk_export`의 `schema_fingerprint`와 같은 규칙이다.
   */
  readonly requiredFields: readonly string[];
  /** "그 조건의 기록이 없다"를 담는 필드. `{"found": false}`의 `found`. */
  readonly recordAbsentField: string | null;
  /** 그 필드가 이 값이면 기록 없음이다. `found`에 대해 `"false"`. */
  readonly recordAbsentValue: string | null;
  /** 200인데 업무 오류를 담는 필드. 값이 있으면 성공이 아니다. */
  readonly businessErrorField: string | null;
}

/**
 * 본문 판정.
 *
 * 상태 코드와 분리한다 — 200이라는 사실과 그 본문이 우리가 아는 답이라는 사실은
 * 다른 것이고, 둘을 합치면 전자가 후자를 덮는다.
 */
export type BodyVerdict =
  | "match"
  | "no_record"
  | "business_error"
  | "drift"
  | "unprofiled"
  | "unparsable"
  | "empty";

export interface BodyEvaluation {
  readonly verdict: BodyVerdict;
  readonly detail: string | null;
  readonly parsed: unknown;
}

/** 최상위 필드를 읽는다. 중첩 경로는 profile이 자라면 그때 만든다. */
function fieldOf(parsed: unknown, field: string): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return (parsed as Record<string, unknown>)[field];
}

/**
 * 응답 본문을 profile로 판정한다.
 *
 * 순서가 규칙이다. 업무 오류와 기록 없음을 **필드 대조보다 먼저** 본다 —
 * 그 응답들은 정상 응답의 필드를 갖지 않으므로, 순서를 뒤집으면 전부
 * `schema_changed`가 되어 "출처가 뭐라고 답했는가"를 잃는다.
 */
export function evaluateResponseBody(body: string, profile: ResponseProfile): BodyEvaluation {
  if (body.trim().length === 0) return { verdict: "empty", detail: null, parsed: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // JSON이 아니다. 값을 추측하지 않는다.
    return { verdict: "unparsable", detail: null, parsed: null };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { verdict: "drift", detail: "최상위가 객체가 아니다", parsed };
  }

  if (profile.businessErrorField) {
    const value = fieldOf(parsed, profile.businessErrorField);
    if (value !== undefined && value !== null && value !== "" && value !== false) {
      return { verdict: "business_error", detail: String(value).slice(0, 200), parsed };
    }
  }

  if (profile.recordAbsentField && profile.recordAbsentValue !== null) {
    const value = fieldOf(parsed, profile.recordAbsentField);
    if (value !== undefined && String(value) === profile.recordAbsentValue) {
      return { verdict: "no_record", detail: null, parsed };
    }
  }

  // 선언이 없으면 일치를 말할 수 없다. 200과 유효 JSON은 형식일 뿐이다.
  if (profile.requiredFields.length === 0) {
    return { verdict: "unprofiled", detail: null, parsed };
  }

  const missing = profile.requiredFields.filter(
    (field) => fieldOf(parsed, field) === undefined,
  );
  if (missing.length > 0) {
    return { verdict: "drift", detail: `없는 필드: ${missing.join(", ")}`, parsed };
  }

  return { verdict: "match", detail: null, parsed };
}

/**
 * HTTP 응답을 12개 결과 중 하나로 정규화한다.
 *
 * **여기가 이 모듈의 핵심이다.** 상태 코드를 그대로 성공/실패로 나누면
 * "기록 없음"(404)과 "출처 장애"(503)가 같은 실패가 되고, 사용자는 존재하지
 * 않는 기록을 계속 재시도한다.
 */
export function classifyHttpResponse(input: {
  readonly status: number;
  readonly signatureValid: boolean | null;
  /** 본문 판정. `evaluateResponseBody`가 만든다. */
  readonly body: BodyVerdict;
}): SourceResult {
  // 인증 실패와 권한 없음은 다르다. 전자는 우리 설정 문제고 후자는 협의 문제다.
  if (input.status === 401) return "authentication_failed";
  if (input.status === 403) return "access_not_authorized";

  // 404는 장애가 아니라 사실이다 — 그 조건으로는 기록이 없다.
  if (input.status === 404) return "source_returned_no_record";

  if (input.status === 429 || input.status >= 500) return "source_unavailable";

  // 3xx. 리다이렉트를 따라가지 않는다 — 출처가 우리를 다른 곳으로 보내고 있고,
  // 그 대상이 내부망일 수 있다. 자동으로 따라가면 등록부 조회가 내부 주소를
  // 읽는 통로가 된다. 사람이 새 주소를 확인하고 설정을 고친다.
  if (input.status >= 300 && input.status < 400) return "manual_review_required";

  if (input.status >= 200 && input.status < 300) {
    // 서명이 붙은 응답인데 검증에 실패했다. 내용이 맞더라도 신뢰할 수 없다.
    if (input.signatureValid === false) return "signature_invalid";

    switch (input.body) {
      // 스키마가 바뀌었다. 파싱은 되지만 우리가 아는 형식이 아니다 — 값을
      // 추측해 넣으면 틀린 사실이 기록된다.
      case "unparsable":
      case "drift":
        return "schema_changed";

      // 출처가 "그 조건의 기록이 없다"고 답했다. 장애가 아니라 사실이다.
      case "no_record":
        return "source_returned_no_record";

      /**
       * 200인데 본문이 업무 오류를 담고 있다.
       *
       * `source_unavailable`로 두지 않는다 — 그것은 재시도 대상이고 연동을
       * degraded로 만든다. 출처가 무엇을 말했는지 우리가 모르는 상태에서
       * 그렇게 단정할 수 없다. 사람이 detail을 읽는다.
       */
      case "business_error":
        return "manual_review_required";

      // 200인데 본문이 비었다. 기록 없음과 구분되지 않으므로 사람이 본다.
      case "empty":
        return "manual_review_required";

      /**
       * 이 출처의 정상 응답이 어떻게 생겼는지 선언되지 않았다.
       *
       * **여기가 A7의 핵심이다.** 파싱 성공만으로 확정하면 `{}`도
       * `{"error":"..."}`도 확인이 된다. 선언이 없으면 확정하지 않는다.
       */
      case "unprofiled":
        return "manual_review_required";

      case "match":
        return "confirmed_from_source";
    }
  }

  // 알 수 없는 상태. 성공으로 넘기지 않는다.
  return "manual_review_required";
}

/** 원문 해시. 재현 가능성의 근거이며 저장소를 신뢰 기반에서 뺀다. */
export function hashRawResponse(body: string): string {
  return `0x${createHash("sha256").update(body).digest("hex")}`;
}

export interface InvokeInput {
  readonly descriptor: AdapterDescriptor;
  readonly config: HttpAdapterConfig;
  readonly queryBasis: Readonly<Record<string, string>>;
}

/**
 * HTTP adapter 호출.
 *
 * **호출 가능 여부를 먼저 판정한다.** `pending_access`인 출처를 부르면 미확인
 * 통합을 약속하는 것이 되고, 401을 받아 "인증 실패"로 기록하게 된다 — 실제로는
 * 협의가 안 된 것이다.
 */
export async function invokeHttpAdapter(
  input: InvokeInput,
  fetchImpl: SourceFetch = pinnedFetch,
  resolveHost: HostResolver = dnsResolver,
): Promise<AdapterInvocation> {
  const availability = checkAdapterAvailable(input.descriptor);
  if (!availability.callable) {
    return {
      kind: "failed",
      // 접근이 승인되지 않은 것을 인증 실패로 기록하지 않는다.
      result:
        availability.reason === "MANUAL_COLLECTION_ONLY"
          ? "manual_review_required"
          : "access_not_authorized",
      detail: availability.nextAction,
    };
  }

  /**
   * 부르기 직전에 대상을 다시 본다 — SSRF.
   *
   * 저장 시점에도 검사하지만 그것만으로는 이름이 사설 주소를 가리키도록 DNS를
   * 바꾸는 우회를 막지 못한다. 여기서 걸리면 요청을 보내지 않았으므로 출처
   * 장애가 아니라 우리 설정 문제다 — 결과를 그렇게 기록한다.
   *
   * **판정에 쓴 주소를 받아 그대로 연결한다.** 다시 풀면 그 사이에 응답이
   * 바뀔 수 있고(rebinding), 그러면 검사한 주소와 연결한 주소가 다르다.
   */
  let pinnedAddresses: readonly string[];
  try {
    pinnedAddresses = await assertEndpointReachable(input.config.endpoint, resolveHost);
  } catch (error) {
    return {
      kind: "failed",
      result: "manual_review_required",
      detail: error instanceof Error ? error.message : "endpoint를 사용할 수 없다",
    };
  }

  const url = new URL(input.config.endpoint);
  for (const [key, value] of Object.entries(input.queryBasis)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);

  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(url, {
      headers: input.config.headers,
      signal: controller.signal,
      // 리다이렉트를 따라가지 않는다. 위 분류가 3xx를 사람 확인으로 돌린다.
      redirect: "manual",
      pinnedAddresses,
    });
    body = await response.text();
  } catch (error) {
    // 응답이 상한을 넘은 것은 출처 장애가 아니다. 우리가 읽지 못한 것이고,
    // 무엇이 왔는지는 사람이 확인한다.
    if (error instanceof SourceResponseTooLargeError) {
      return { kind: "failed", result: "manual_review_required", detail: error.message };
    }
    // 타임아웃·연결 실패는 출처 장애다. 기록 없음이 아니다.
    return {
      kind: "failed",
      result: "source_unavailable",
      detail: String(error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }

  const evaluation = evaluateResponseBody(body, input.config.responseProfile);

  const result = classifyHttpResponse({
    status: response.status,
    // 서명 검증은 출처마다 방식이 달라 R5 profile에서 붙인다.
    signatureValid: null,
    body: evaluation.verdict,
  });

  if (result !== "confirmed_from_source") {
    return {
      kind: "failed",
      result,
      detail: evaluation.detail
        ? `HTTP ${response.status} — ${evaluation.detail}`
        : `HTTP ${response.status} (${evaluation.verdict})`,
    };
  }

  return {
    kind: "outcome",
    outcome: {
      result,
      rawHash: hashRawResponse(body),
      queryBasis: input.queryBasis,
      // adapter가 더할 한계는 여기서 넣지 않는다. authority가 선언한 것이
      // `toReceiptInput`에서 반드시 합쳐진다.
      limitations: [],
      effectiveAt: extractEffectiveAt(evaluation.parsed, input.config.effectiveAtField),
    },
  };
}

/**
 * 출처가 밝힌 기준일.
 *
 * 조회 시각과 다르다 — 등록부가 어제 갱신됐다면 오늘 조회해도 기준일은 어제다.
 * 둘을 같게 두면 자료가 실제보다 최신으로 보인다.
 */
function extractEffectiveAt(parsed: unknown, field: string | null): string | null {
  if (!field || parsed === null || typeof parsed !== "object") return null;

  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value !== "string") return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * adapter 결과를 Source Receipt 본문으로 만든다.
 *
 * `toReceiptInput`이 authority의 한계를 반드시 합친다 — adapter가 빠뜨려도
 * 한계 없는 receipt가 만들어지지 않는다.
 */
export function buildReceiptBody(
  descriptor: AdapterDescriptor,
  invocation: AdapterInvocation,
  extra: {
    readonly connectionId: string;
    readonly authorityId: string;
    readonly collectionMethod: string;
    readonly authenticationMethod: string;
    readonly endpointOrDocumentRef: string;
    readonly sourceSchemaVersion: string;
    readonly adapterVersion: string;
    readonly termsLicense: string;
    readonly commercialReuse: string;
    readonly disclosurePermission: string;
  },
): Record<string, unknown> {
  const normalized = toReceiptInput(descriptor, invocation);

  return {
    connectionId: extra.connectionId,
    authorityId: extra.authorityId,
    result: normalized.result,
    collectionMethod: extra.collectionMethod,
    queryBasis: normalized.queryBasis,
    endpointOrDocumentRef: extra.endpointOrDocumentRef,
    authenticationMethod: extra.authenticationMethod,
    // 조회에 실패하면 원문이 없다. 가짜 해시를 만들지 않는다.
    rawHash: normalized.rawHash ?? `0x${"0".repeat(64)}`,
    sourceSchemaVersion: extra.sourceSchemaVersion,
    adapterVersion: extra.adapterVersion,
    termsLicense: extra.termsLicense,
    commercialReuse: extra.commercialReuse,
    disclosurePermission: extra.disclosurePermission,
    asOf: new Date().toISOString(),
    effectiveAt: normalized.effectiveAt,
    freshnessStatus: normalized.effectiveAt ? "fresh" : "unknown",
    limitations: normalized.limitations,
  };
}
