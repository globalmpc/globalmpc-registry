/**
 * Readiness 상태와 gate decision — spec 04 §4.2 / 05 §5.4.
 *
 * 이 모듈이 강제하는 것은 하나다: **준비도는 결정이 아니다.**
 * readiness가 전부 `ok`여도 사람의 GateDecision 없이는 lifecycle이 전이하지 않고
 * (AC-03), `gap`이나 `not_evaluable`이 하나라도 있으면 `go`가 불가능하다
 * (AC-02, AC-34).
 */

export const READINESS_STATUSES = ["ok", "watch", "gap", "not_evaluable"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const GATE_DECISIONS = ["go", "hold", "rework", "stop"] as const;
export type GateDecisionValue = (typeof GATE_DECISIONS)[number];

/**
 * 집계 우선순위 — 나쁠수록 낮다.
 *
 * `not_evaluable`을 `gap`보다 낮게 두는 이유: `gap`은 "필요한 근거가 없다"이고
 * `not_evaluable`은 "판단 기준 자체가 없다"이다. 후자는 무엇을 채워야 할지도
 * 모르는 상태이므로 더 나쁘다. 둘 다 go-blocking인 것은 같다.
 */
const READINESS_RANK: Readonly<Record<ReadinessStatus, number>> = {
  not_evaluable: 0,
  gap: 1,
  watch: 2,
  ok: 3,
};

/** go를 차단하는 상태. 이 집합을 configuration으로 바꾸는 경로는 없다(§4.2). */
const GO_BLOCKING: ReadonlySet<ReadinessStatus> = new Set<ReadinessStatus>([
  "gap",
  "not_evaluable",
]);

export function isGoBlocking(status: ReadinessStatus): boolean {
  return GO_BLOCKING.has(status);
}

/** requirement 결과들의 전체 status — 최악값. 빈 집합은 not_evaluable이다. */
export function aggregateReadiness(statuses: readonly ReadinessStatus[]): ReadinessStatus {
  if (statuses.length === 0) return "not_evaluable";
  return statuses.reduce((worst, current) =>
    READINESS_RANK[current] < READINESS_RANK[worst] ? current : worst,
  );
}

export type GateDenyReason =
  | "GATE_GAP_BLOCKS_GO"
  | "GATE_NOT_EVALUABLE_BLOCKS_GO"
  | "GATE_WATCH_REQUIRES_RATIONALE"
  | "GATE_MISSING_ASSESSMENT";

export interface GateDecisionRequest {
  readonly decision: GateDecisionValue;
  readonly requirementStatuses: readonly ReadinessStatus[];
  /** 평가가 아예 없으면 false. */
  readonly hasAssessment: boolean;
  /** watch → go 승격 시 필수(§11.3). */
  readonly rationale: string | null;
}

export type GateDecisionCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: GateDenyReason;
      readonly blockingRequirementIndexes: readonly number[];
    };

/**
 * GateDecision 허용 여부.
 *
 * `go` 이외의 결정(`hold`/`rework`/`stop`)은 준비도와 무관하게 언제나 기록할 수
 * 있다. 나쁜 소식을 기록하지 못하게 막으면 상태가 조용히 낡는다.
 */
export function checkGateDecision(request: GateDecisionRequest): GateDecisionCheck {
  if (!request.hasAssessment) {
    return {
      allowed: false,
      reason: "GATE_MISSING_ASSESSMENT",
      blockingRequirementIndexes: [],
    };
  }

  if (request.decision !== "go") {
    return { allowed: true };
  }

  const notEvaluable = indexesOf(request.requirementStatuses, "not_evaluable");
  if (notEvaluable.length > 0) {
    return {
      allowed: false,
      reason: "GATE_NOT_EVALUABLE_BLOCKS_GO",
      blockingRequirementIndexes: notEvaluable,
    };
  }

  const gaps = indexesOf(request.requirementStatuses, "gap");
  if (gaps.length > 0) {
    return {
      allowed: false,
      reason: "GATE_GAP_BLOCKS_GO",
      blockingRequirementIndexes: gaps,
    };
  }

  const watches = indexesOf(request.requirementStatuses, "watch");
  if (watches.length > 0 && (request.rationale === null || request.rationale.trim() === "")) {
    return {
      allowed: false,
      reason: "GATE_WATCH_REQUIRES_RATIONALE",
      blockingRequirementIndexes: watches,
    };
  }

  return { allowed: true };
}

function indexesOf(
  statuses: readonly ReadinessStatus[],
  target: ReadinessStatus,
): number[] {
  const out: number[] = [];
  for (const [index, status] of statuses.entries()) {
    if (status === target) out.push(index);
  }
  return out;
}
