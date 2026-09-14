import { canonicalBytes, keccak256, type Hex } from "@mpc/canonical";
import {
  aggregateReadiness,
  gradeAtLeast,
  type AttestationType,
  type Grade,
  type ReadinessStatus,
} from "@mpc/domain";
import { evaluatePredicate, type Facts } from "./predicate.js";
import type { Requirement, RuleSet } from "./rule-schema.js";

/**
 * Compliance Policy Engine — 결정적 평가.
 *
 * spec 13 AC-11: 동일 input snapshot hash와 rule version이면 여러 worker에서
 * 평가해도 byte-equivalent canonical result hash가 나온다.
 *
 * 그래서 이 모듈은 순수 함수다 — 현재 시각을 읽지 않고, 난수를 쓰지 않고, 외부를
 * 조회하지 않는다. 시간 기준은 입력 snapshot의 `evaluatedAsOf`이며 경과일도
 * 호출자가 계산해 넣는다.
 *
 * 사용자 표시명은 "데이터·증빙 준비도 평가"다. 법률 컴플라이언스 승인이나 인가
 * 판정이 아니다(11 §11.13).
 */

export interface RequirementFacts {
  /** 이 requirement를 위해 존재하는 claim type. */
  readonly presentClaimTypes: readonly string[];
  /** 근거 claim들의 weakest link grade. 근거가 없으면 null. */
  readonly grade: Grade | null;
  readonly presentAttestations: readonly AttestationType[];
  /** 근거의 경과일. 정수 decimal string. 알 수 없으면 null. */
  readonly evidenceAgeDays: string | null;
  readonly unresolvedConflictTypes: readonly string[];
  /** appliesWhen·notEvaluableWhen·watchWhen이 참조하는 추가 사실. */
  readonly context: Facts;
}

export interface AssessmentInput {
  readonly subjectId: string;
  readonly gateId: string;
  /** 평가 입력 전체의 커밋먼트. 이 값이 같으면 결과도 같아야 한다. */
  readonly inputSnapshotHash: string;
  /** 평가 기준 시각. 현재 시각이 아니라 snapshot에 고정된 값이다. */
  readonly evaluatedAsOf: string;
  readonly requirementFacts: Readonly<Record<string, RequirementFacts>>;
}

export type RequirementReasonCode =
  | "REQUIREMENT_SATISFIED"
  | "REQUIREMENT_NOT_APPLICABLE"
  | "MISSING_REQUIRED_CLAIM_TYPE"
  | "GRADE_BELOW_MINIMUM"
  | "MISSING_REQUIRED_ATTESTATION"
  | "EVIDENCE_STALE"
  | "BLOCKING_CONFLICT"
  | "NO_EVALUATION_BASIS"
  | "FACTS_NOT_SUPPLIED"
  | "WATCH_CONDITION_MET";

export interface RequirementResult {
  readonly requirementId: string;
  readonly status: ReadinessStatus;
  /** false면 집계에서 제외된다. */
  readonly applicable: boolean;
  readonly reasonCode: RequirementReasonCode;
  /** 무엇이 부족한지 — UI가 다음 행동을 안내하는 데 쓴다. */
  readonly missing: readonly string[];
}

export interface Assessment {
  readonly subjectId: string;
  readonly gateId: string;
  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
  readonly inputSnapshotHash: string;
  readonly evaluatedAsOf: string;
  readonly status: ReadinessStatus;
  readonly requirementResults: readonly RequirementResult[];
}

export function evaluateRequirement(
  requirement: Requirement,
  facts: RequirementFacts | undefined,
): RequirementResult {
  const base = { requirementId: requirement.requirementId } as const;

  if (facts === undefined) {
    // 사실이 공급되지 않았다. 통과로 처리하지 않는다.
    return {
      ...base,
      status: "not_evaluable",
      applicable: true,
      reasonCode: "FACTS_NOT_SUPPLIED",
      missing: ["requirement_facts"],
    };
  }

  if (!evaluatePredicate(requirement.appliesWhen, facts.context)) {
    return {
      ...base,
      status: "ok",
      applicable: false,
      reasonCode: "REQUIREMENT_NOT_APPLICABLE",
      missing: [],
    };
  }

  // 판단 기준 자체가 없는 경우가 근거 결여보다 먼저다.
  if (evaluatePredicate(requirement.notEvaluableWhen, facts.context)) {
    return {
      ...base,
      status: "not_evaluable",
      applicable: true,
      reasonCode: "NO_EVALUATION_BASIS",
      missing: [],
    };
  }

  const missingClaimTypes = requirement.requiredClaimTypes.filter(
    (claimType) => !facts.presentClaimTypes.includes(claimType),
  );
  if (missingClaimTypes.length > 0) {
    return {
      ...base,
      status: "gap",
      applicable: true,
      reasonCode: "MISSING_REQUIRED_CLAIM_TYPE",
      missing: missingClaimTypes,
    };
  }

  if (facts.grade === null || !gradeAtLeast(facts.grade, requirement.minimumGrade)) {
    return {
      ...base,
      status: "gap",
      applicable: true,
      reasonCode: "GRADE_BELOW_MINIMUM",
      missing: [requirement.minimumGrade],
    };
  }

  const missingAttestations = requirement.requiredAttestations.filter(
    (attestation) => !facts.presentAttestations.includes(attestation),
  );
  if (missingAttestations.length > 0) {
    return {
      ...base,
      status: "gap",
      applicable: true,
      reasonCode: "MISSING_REQUIRED_ATTESTATION",
      missing: missingAttestations,
    };
  }

  if (requirement.freshnessThresholdDays !== null) {
    if (facts.evidenceAgeDays === null) {
      // 경과일을 모르면 최신성을 판단할 수 없다. 통과시키지 않는다.
      return {
        ...base,
        status: "not_evaluable",
        applicable: true,
        reasonCode: "NO_EVALUATION_BASIS",
        missing: ["evidence_age"],
      };
    }
    if (BigInt(facts.evidenceAgeDays) > BigInt(requirement.freshnessThresholdDays)) {
      return {
        ...base,
        status: "gap",
        applicable: true,
        reasonCode: "EVIDENCE_STALE",
        missing: [`max_age_days:${requirement.freshnessThresholdDays}`],
      };
    }
  }

  const blockingConflicts = facts.unresolvedConflictTypes.filter((conflict) =>
    requirement.blockingConflictTypes.includes(conflict),
  );
  if (blockingConflicts.length > 0) {
    return {
      ...base,
      status: "gap",
      applicable: true,
      reasonCode: "BLOCKING_CONFLICT",
      missing: blockingConflicts,
    };
  }

  if (requirement.watchWhen !== null && evaluatePredicate(requirement.watchWhen, facts.context)) {
    return {
      ...base,
      status: "watch",
      applicable: true,
      reasonCode: "WATCH_CONDITION_MET",
      missing: [],
    };
  }

  return {
    ...base,
    status: "ok",
    applicable: true,
    reasonCode: "REQUIREMENT_SATISFIED",
    missing: [],
  };
}

export function evaluateAssessment(ruleSet: RuleSet, input: AssessmentInput): Assessment {
  const requirementResults = ruleSet.requirements.map((requirement) =>
    evaluateRequirement(requirement, input.requirementFacts[requirement.requirementId]),
  );

  const applicableStatuses = requirementResults
    .filter((result) => result.applicable)
    .map((result) => result.status);

  return {
    subjectId: input.subjectId,
    gateId: input.gateId,
    ruleSetId: ruleSet.ruleSetId,
    ruleSetVersion: ruleSet.version,
    inputSnapshotHash: input.inputSnapshotHash,
    evaluatedAsOf: input.evaluatedAsOf,
    status: aggregateReadiness(applicableStatuses),
    requirementResults,
  };
}

/**
 * assessment의 canonical 커밋먼트.
 *
 * 같은 `(inputSnapshotHash, ruleSetVersion)`은 항상 같은 값을 만든다. 이 해시가
 * GateDecision의 입력으로 기록되므로, 나중에 "그때 무엇을 보고 결정했는가"를
 * 재현할 수 있다.
 */
export function assessmentHash(assessment: Assessment): Hex {
  return keccak256(canonicalBytes(toCanonical(assessment)));
}

function toCanonical(assessment: Assessment) {
  return {
    subjectId: assessment.subjectId,
    gateId: assessment.gateId,
    ruleSetId: assessment.ruleSetId,
    ruleSetVersion: assessment.ruleSetVersion,
    inputSnapshotHash: assessment.inputSnapshotHash,
    evaluatedAsOf: assessment.evaluatedAsOf,
    status: assessment.status,
    // requirementId로 정렬해 배열 순서에 대한 의존을 없앤다.
    requirementResults: [...assessment.requirementResults]
      .sort((a, b) => (a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0))
      .map((result) => ({
        requirementId: result.requirementId,
        status: result.status,
        applicable: result.applicable,
        reasonCode: result.reasonCode,
        missing: [...result.missing].sort(),
      })),
  };
}
