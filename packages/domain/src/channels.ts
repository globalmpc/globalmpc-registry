import type { CollectionMethod, SourceResult } from "./source-result.js";

export type { CollectionMethod };

/**
 * Evidence channel parity — spec 05 §5.12, AC-29, OD-42.
 *
 * 네 채널이 같은 Source Receipt와 같은 result enum을 쓴다. 그것이 parity의
 * 뜻이다 — 읽는 쪽이 "어느 경로로 왔나"에 따라 다르게 해석하지 않아도 된다.
 *
 * **하지만 각 채널이 막아야 하는 것은 다르다.** API는 상태 코드로 실패를
 * 알리지만, 파일로 받는 채널에는 상태 코드가 없다. 대신 파일이 우리가 아는
 * 형식인지, 서명이 맞는지를 봐야 한다.
 *
 * AC-29가 명시한 셋을 여기서 판정한다:
 *
 *   1. signed document의 invalid signature
 *   2. bulk export의 schema drift
 *   3. manual confirmation의 second-review 누락
 */

// --- bulk export -----------------------------------------------------------

export interface SchemaDrift {
  readonly drifted: boolean;
  /** 선언에 없던 필드. 새 컬럼이 생겼다. */
  readonly added: readonly string[];
  /** 선언에 있었는데 사라진 필드. 이쪽이 위험하다. */
  readonly removed: readonly string[];
}

/**
 * 스키마 drift 판정.
 *
 * **사라진 필드가 더 위험하다.** 새 컬럼은 무시하면 그만이지만, 있던 컬럼이
 * 사라지면 우리가 읽던 값이 없는 것이다. 그런데 파서는 `undefined`를 받아
 * 조용히 빈 값으로 넘길 수 있다.
 *
 * 선언이 비어 있으면 대조하지 않는다 — 모르는 것을 일치로 읽지 않기 위해
 * `drifted: false`를 주되, 호출하는 쪽이 `compared`로 그 사실을 안다.
 */
export function detectSchemaDrift(
  declared: readonly string[],
  observed: readonly string[],
): SchemaDrift & { readonly compared: boolean } {
  if (declared.length === 0) {
    return { drifted: false, added: [], removed: [], compared: false };
  }

  const declaredSet = new Set(declared);
  const observedSet = new Set(observed);

  const added = observed.filter((field) => !declaredSet.has(field));
  const removed = declared.filter((field) => !observedSet.has(field));

  return { drifted: removed.length > 0 || added.length > 0, added, removed, compared: true };
}

/**
 * bulk export 결과 판정.
 *
 * drift가 있으면 `schema_changed`다. **값을 추측해 넣지 않는다** — 컬럼이
 * 바뀐 파일에서 읽은 값은 다른 것을 가리킬 수 있다.
 */
export function classifyBulkExport(input: {
  readonly declaredFields: readonly string[];
  readonly observedFields: readonly string[];
  readonly recordFound: boolean;
}): { readonly result: SourceResult; readonly drift: SchemaDrift } {
  const drift = detectSchemaDrift(input.declaredFields, input.observedFields);

  if (drift.drifted) {
    return { result: "schema_changed", drift };
  }

  // 대조하지 않았다면 확정할 수 없다. 사람이 스키마를 등록해야 한다.
  if (!drift.compared) {
    return { result: "manual_review_required", drift };
  }

  // 파일은 정상인데 그 조건의 기록이 없다. 장애가 아니라 사실이다.
  if (!input.recordFound) {
    return { result: "source_returned_no_record", drift };
  }

  return { result: "confirmed_from_source", drift };
}

// --- signed document -------------------------------------------------------

/**
 * 서명 문서 결과 판정.
 *
 * 서명이 **검증되지 않은 것**과 **검증에 실패한 것**을 구분한다. 전자는 우리가
 * 확인할 방법이 없는 것(공개키 미등록)이고 후자는 문서가 변조됐거나 다른
 * 서명자의 것이다. 둘을 합치면 공개키를 등록하지 않는 것으로 검증을 건너뛸 수
 * 있다.
 */
export function classifySignedDocument(input: {
  /** null이면 검증을 시도하지 못했다. */
  readonly signatureValid: boolean | null;
  /** 서명자가 이 authority의 등록된 서명자인가. */
  readonly signerRecognized: boolean;
  readonly recordFound: boolean;
}): SourceResult {
  if (input.signatureValid === false) return "signature_invalid";

  // 검증할 키가 없다. 서명이 있다는 사실만으로 신뢰하지 않는다.
  if (input.signatureValid === null) return "manual_review_required";

  // 서명은 유효하지만 우리가 아는 서명자가 아니다. 유효한 서명은 서명자가
  // 누구인지를 말하지 않는다.
  if (!input.signerRecognized) return "signature_invalid";

  if (!input.recordFound) return "source_returned_no_record";

  return "confirmed_from_source";
}

// --- manual confirmation ---------------------------------------------------

/** 이 채널은 두 번째 검토를 요구하는가. */
export function requiresSecondReview(method: CollectionMethod): boolean {
  // 수동 확인에는 API 응답도 서명도 없다. 한 사람의 진술이 유일한 근거다.
  return method === "manual_official_registry_confirmation";
}

export type SecondReviewCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

/**
 * 두 번째 검토 판정 — AC-29.
 *
 * **같은 사람이 두 번 확인할 수 없다.** second review의 목적은 다른 눈이고,
 * 같은 사람을 허용하면 절차만 남는다.
 */
export function checkSecondReview(input: {
  readonly firstConfirmedBy: string | null;
  readonly secondConfirmedBy: string | null;
}): SecondReviewCheck {
  if (!input.secondConfirmedBy) {
    return {
      ok: false,
      reason: "수동 확인은 두 번째 검토 없이 확정될 수 없다",
      nextAction: "다른 사람이 같은 등록부를 조회해 확인한다",
    };
  }

  if (input.secondConfirmedBy === input.firstConfirmedBy) {
    return {
      ok: false,
      reason: "처음 확인한 사람이 두 번째 검토를 할 수 없다",
      nextAction: "다른 사람이 확인한다",
    };
  }

  return { ok: true };
}

/**
 * 채널이 확정 결과를 낼 자격을 갖췄는가.
 *
 * receipt를 만들기 전에 부른다. DB CHECK가 같은 것을 막지만 거기서 걸리면
 * 500이 나가고, 사용자는 **무엇을 더 해야 하는지** 알 수 없다.
 */
export function checkChannelReady(input: {
  readonly method: CollectionMethod;
  readonly result: SourceResult;
  readonly signatureValid?: boolean | null;
  readonly observedFields?: readonly string[] | null;
  readonly secondConfirmedBy?: string | null;
  readonly firstConfirmedBy?: string | null;
}): SecondReviewCheck {
  // 확정이 아니면 채널 요건을 묻지 않는다. 실패는 실패대로 기록돼야 한다.
  if (input.result !== "confirmed_from_source") return { ok: true };

  if (input.method === "manual_official_registry_confirmation") {
    return checkSecondReview({
      firstConfirmedBy: input.firstConfirmedBy ?? null,
      secondConfirmedBy: input.secondConfirmedBy ?? null,
    });
  }

  if (input.method === "verifiable_signed_document" && input.signatureValid !== true) {
    return {
      ok: false,
      reason: "서명이 검증되지 않은 문서는 확정될 수 없다",
      nextAction: "서명자의 공개키를 등록하고 다시 검증한다",
    };
  }

  if (input.method === "official_bulk_export" && !input.observedFields) {
    return {
      ok: false,
      reason: "관측된 스키마 없이 bulk export를 확정할 수 없다",
      nextAction: "파일에서 읽은 필드 목록을 함께 보낸다",
    };
  }

  return { ok: true };
}
