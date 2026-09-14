/**
 * Readiness status and gate decision — spec 04 §4.2 / 05 §5.4.
 *
 * This module enforces one thing: **readiness is not a decision.**
 * Even if every readiness result is `ok`, the lifecycle does not transition without a human
 * GateDecision (AC-03), and a single `gap` or `not_evaluable` makes `go` impossible
 * (AC-02, AC-34).
 */

export const READINESS_STATUSES = ["ok", "watch", "gap", "not_evaluable"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const GATE_DECISIONS = ["go", "hold", "rework", "stop"] as const;
export type GateDecisionValue = (typeof GATE_DECISIONS)[number];

/**
 * Aggregation precedence — worse is lower.
 *
 * Why `not_evaluable` ranks below `gap`: `gap` means "required evidence is missing" while
 * `not_evaluable` means "there is no criterion to judge by". The latter does not even know what
 * to fill in, so it is worse. Both block go all the same.
 */
const READINESS_RANK: Readonly<Record<ReadinessStatus, number>> = {
  not_evaluable: 0,
  gap: 1,
  watch: 2,
  ok: 3,
};

/** States that block go. No path turns this set into configuration (§4.2). */
const GO_BLOCKING: ReadonlySet<ReadinessStatus> = new Set<ReadinessStatus>([
  "gap",
  "not_evaluable",
]);

export function isGoBlocking(status: ReadinessStatus): boolean {
  return GO_BLOCKING.has(status);
}

/** Overall status of requirement results — the worst value. An empty set is not_evaluable. */
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
  /** false when there is no evaluation at all. */
  readonly hasAssessment: boolean;
  /** Required when promoting watch → go (§11.3). */
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
 * Whether a GateDecision is allowed.
 *
 * Decisions other than `go` (`hold`/`rework`/`stop`) can always be recorded regardless of
 * readiness. Blocking bad news from being recorded lets state go quietly stale.
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
