/**
 * Evidence Adapter Framework — spec 05 §5.12, OD-42.
 *
 * 정부 등록부·전문기관·ERSP·수동 확인을 **하나의 Source Receipt envelope**으로
 * 묶는다. adapter마다 다른 결과 형식을 쓰면 12개 source result가 adapter 수만큼
 * 갈라지고, 화면은 그것을 다시 통합해야 한다.
 *
 * 이 파일에는 특정 기관이 없다. **Core에 기관·법률·schema를 hard-code하지
 * 않는다**(OD-43) — Mongolia profile은 설정으로 들어오고, 확인된 연동만 활성화된다.
 *
 * adapter가 지켜야 하는 것:
 *
 * 1. **실패를 성공으로 만들지 않는다.** 조회가 안 되면 `source_unavailable`이지
 *    `source_returned_no_record`가 아니다. 둘을 섞으면 사용자는 존재하지 않는
 *    기록을 계속 재시도한다.
 * 2. **원문 해시를 남긴다.** 나중에 같은 조회를 재현했을 때 응답이 바뀌었는지
 *    확인할 수 있어야 한다.
 * 3. **무엇을 확인하지 않았는지 말한다.** authority의 `does_not_prove`가 그대로
 *    receipt의 `limitations`에 들어간다.
 */

import type { SourceResult } from "./source-result.js";

/**
 * adapter 운영 상태 — OD-43.
 *
 * `active`만 실제로 호출된다. 나머지는 **연동이 준비되지 않았다는 사실을
 * 드러내기 위해** 존재한다 — 목록에서 빼면 "왜 이 기관은 없나"를 알 수 없다.
 */
export const ADAPTER_STATES = [
  /** 접근 권한이 확인됐고 호출된다. */
  "active",
  /** 사람이 조회해 결과를 입력한다. API가 없거나 접근 협의 중이다. */
  "manual",
  /** 기관은 확인됐지만 접근 권한이 없다. 호출하지 않는다. */
  "pending_access",
  /** 법적·계약적 이유로 쓸 수 없다. */
  "blocked",
] as const;

export type AdapterState = (typeof ADAPTER_STATES)[number];

export interface AdapterDescriptor {
  readonly connectionKey: string;
  readonly authorityName: string;
  readonly jurisdiction: string;
  readonly state: AdapterState;
  /** 이 출처가 확인해 주는 것. authority의 `proves`와 같다. */
  readonly proves: readonly string[];
  /** 확인해 주지 않는 것. 비어 있을 수 없다(05 §5.11). */
  readonly doesNotProve: readonly string[];
  /** 왜 이 상태인가. `pending_access`·`blocked`에서 특히 필요하다. */
  readonly stateReason: string;
}

export type AdapterAvailability =
  | { readonly callable: true }
  | { readonly callable: false; readonly reason: string; readonly nextAction: string };

/**
 * 지금 이 adapter를 호출할 수 있는가.
 *
 * `manual`은 호출 대상이 아니지만 **막힌 것도 아니다** — 사람이 조회한다. 그
 * 구분을 없애면 수동 확인이 장애처럼 보인다.
 */
export function checkAdapterAvailable(descriptor: AdapterDescriptor): AdapterAvailability {
  switch (descriptor.state) {
    case "active":
      return { callable: true };
    case "manual":
      return {
        callable: false,
        reason: "MANUAL_COLLECTION_ONLY",
        nextAction: "공식 창구에서 조회한 뒤 결과를 수동으로 기록한다",
      };
    case "pending_access":
      return {
        callable: false,
        reason: "ACCESS_NOT_GRANTED",
        nextAction: "기관과 접근 권한을 협의한다. 확인 전까지 호출하지 않는다",
      };
    case "blocked":
      return {
        callable: false,
        reason: "LEGALLY_BLOCKED",
        nextAction: "법무 검토 결과를 확인한다",
      };
  }
}

/**
 * adapter 호출 결과.
 *
 * 12개 source result 중 하나로 정규화된다. adapter가 자기 형식을 쓰면 그
 * 형식만큼 판정 분기가 늘어난다.
 */
export interface AdapterOutcome {
  readonly result: SourceResult;
  /** 원문 바이트의 해시. 재현 가능성의 근거다. */
  readonly rawHash: string;
  /** 어떤 조건으로 조회했는가. 같은 조건으로 다시 조회할 수 있어야 한다. */
  readonly queryBasis: Readonly<Record<string, string>>;
  /** 이 조회가 확인하지 않은 것. authority의 `doesNotProve`가 들어온다. */
  readonly limitations: readonly string[];
  /** 출처가 밝힌 기준일. 조회 시각과 다르다. */
  readonly effectiveAt: string | null;
}

export type AdapterInvocation =
  | { readonly kind: "outcome"; readonly outcome: AdapterOutcome }
  /** adapter가 판정하지 못했다. **성공으로 기록하지 않는다.** */
  | { readonly kind: "failed"; readonly result: SourceResult; readonly detail: string };

/**
 * adapter 결과를 Source Receipt 입력으로 바꾼다.
 *
 * **limitations를 여기서 합친다.** adapter가 빠뜨려도 authority가 선언한
 * `doesNotProve`는 반드시 들어간다 — 한계 없는 receipt가 만들어지면 읽는 쪽이
 * 전체 확인으로 오해한다.
 */
export function toReceiptInput(
  descriptor: AdapterDescriptor,
  invocation: AdapterInvocation,
): {
  readonly result: SourceResult;
  readonly limitations: readonly string[];
  readonly rawHash: string | null;
  readonly queryBasis: Readonly<Record<string, string>>;
  readonly effectiveAt: string | null;
} {
  if (invocation.kind === "failed") {
    return {
      result: invocation.result,
      // 실패해도 한계는 그대로 붙는다. 실패한 조회를 "확인 안 됨"으로만 남기면
      // 무엇을 확인하려 했는지 잃는다.
      limitations: [...descriptor.doesNotProve, `조회 실패: ${invocation.detail}`],
      rawHash: null,
      queryBasis: {},
      effectiveAt: null,
    };
  }

  const merged = new Set([...descriptor.doesNotProve, ...invocation.outcome.limitations]);

  return {
    result: invocation.outcome.result,
    limitations: [...merged],
    rawHash: invocation.outcome.rawHash,
    queryBasis: invocation.outcome.queryBasis,
    effectiveAt: invocation.outcome.effectiveAt,
  };
}

/**
 * Jurisdiction Profile — OD-43.
 *
 * 한 관할의 adapter 묶음이다. Core는 이 구조만 알고 내용은 설정으로 온다.
 * 몽골을 먼저 깊게 지원하되 코드에 몽골이 박히지 않게 하는 것이 목적이다.
 */
export interface JurisdictionProfile {
  readonly jurisdiction: string;
  readonly adapters: readonly AdapterDescriptor[];
}

/**
 * profile 검증.
 *
 * **활성 adapter가 하나도 없어도 유효한 profile이다** — 접근 협의 중인 관할이
 * 그렇다. 대신 그 사실이 목록에 드러난다.
 */
export type ProfileIssue = { readonly connectionKey: string; readonly problem: string };

export function validateProfile(profile: JurisdictionProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const seen = new Set<string>();

  for (const adapter of profile.adapters) {
    if (seen.has(adapter.connectionKey)) {
      issues.push({ connectionKey: adapter.connectionKey, problem: "connectionKey가 중복이다" });
    }
    seen.add(adapter.connectionKey);

    // 05 §5.11: 한계를 선언하지 않은 authority는 등록할 수 없다.
    if (adapter.doesNotProve.length === 0) {
      issues.push({
        connectionKey: adapter.connectionKey,
        problem: "doesNotProve가 비어 있다 — 확인하지 않는 것을 반드시 밝힌다",
      });
    }

    if (adapter.proves.length === 0) {
      issues.push({ connectionKey: adapter.connectionKey, problem: "proves가 비어 있다" });
    }

    // 비활성 상태에는 이유가 있어야 한다. "왜 이 기관은 안 되나"에 답할 수
    // 없으면 그 자체가 미확인 통합으로 보인다.
    if (adapter.state !== "active" && adapter.stateReason.trim().length === 0) {
      issues.push({
        connectionKey: adapter.connectionKey,
        problem: `${adapter.state} 상태에는 이유가 필요하다`,
      });
    }

    if (adapter.jurisdiction !== profile.jurisdiction) {
      issues.push({
        connectionKey: adapter.connectionKey,
        problem: "profile의 관할과 adapter의 관할이 다르다",
      });
    }
  }

  return issues;
}

/**
 * connection 상태를 adapter 상태로 읽는다 — 05 §5.11.
 *
 * `source_connections.state`가 원본이고 adapter 상태는 그 해석이다. 별도 컬럼을
 * 두면 둘이 어긋난다. 읽는 곳이 둘 이상이므로 규칙을 여기 한 곳에 둔다 —
 * 화면과 수집 경로가 서로 다르게 읽으면 화면은 호출 가능하다고 말하고 수집은
 * 거절한다.
 */
export function connectionStateToAdapterState(
  connectionState: string | null,
): AdapterState | "none" {
  switch (connectionState) {
    case "active":
      return "active";
    // 접근은 확인됐지만 아직 자동 호출 경로가 없다. 사람이 조회한다.
    case "access_confirmed":
    case "tested":
      return "manual";
    // 타당성 검토·계획 단계다. 호출하면 미확인 통합을 약속하는 것이 된다.
    case "planned":
    case "feasibility_checked":
      return "pending_access";
    case "degraded":
    case "disabled":
      return "blocked";
    case null:
    case undefined:
      // 연동 자체가 없다. 기관은 알지만 접근 경로를 만들지 않았다.
      return "none";
    default:
      // 모르는 상태를 호출 가능으로 읽지 않는다.
      return "pending_access";
  }
}

/** 왜 이 상태인가. `active`가 아닌 것에는 이유가 있어야 한다. */
export function adapterStateReason(
  adapterState: AdapterState | "none",
  connectionState: string | null,
): string {
  switch (adapterState) {
    case "active":
      return "";
    case "manual":
      return "공식 API가 없거나 접근 협의 중이다. 사람이 조회해 결과를 기록한다";
    case "pending_access":
      return `접근 권한이 확인되지 않았다 (연동 상태: ${connectionState ?? "없음"})`;
    case "blocked":
      return `연동이 중단되거나 저하됐다 (연동 상태: ${connectionState})`;
    case "none":
      return "이 기관에 대한 연동이 만들어지지 않았다";
  }
}
