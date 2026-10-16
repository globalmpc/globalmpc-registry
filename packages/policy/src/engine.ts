import { canonicalBytes, keccak256, type Hex } from "@mpc/canonical";
import {
  aggregateReadiness,
  gradeAtLeast,
  type AttestationType,
  type Grade,
  type ReadinessStatus,
} from "@mpc/domain";
import { collectPredicatePaths, evaluatePredicate, type Facts, type Predicate } from "./predicate.js";
import type { Requirement, RuleSet } from "./rule-schema.js";

/**
 * Compliance Policy Engine — deterministic evaluation.
 *
 * spec 13 AC-11: the same input snapshot hash and rule version yield a byte-equivalent canonical
 * result hash on every worker that evaluates them.
 *
 * So this module is pure — it reads no clock, uses no randomness, and queries nothing external.
 * The time basis is the input snapshot's `evaluatedAsOf`; the caller computes elapsed days too.
 *
 * The user-facing name is "data and evidence readiness assessment". It is not a legal compliance
 * approval or an authorization decision (11 §11.13).
 */

export interface RequirementFacts {
  /** Claim types present for this requirement. */
  readonly presentClaimTypes: readonly string[];
  /** Weakest-link grade across evidence claims. null when there is no evidence. */
  readonly grade: Grade | null;
  readonly presentAttestations: readonly AttestationType[];
  /** Evidence age in days, as an integer decimal string. null when unknown. */
  readonly evidenceAgeDays: string | null;
  readonly unresolvedConflictTypes: readonly string[];
  /**
   * Claim types whose evidence has gone stale or expired (REQ-DAPP-026, AC-04).
   *
   * A stale claim keeps its review history, so its grade can still read as passing. What
   * changed is the evidence under it, and that is a gap until someone re-establishes it.
   */
  readonly staleEvidence: readonly string[];
  /**
   * Additional facts referenced by appliesWhen, notEvaluableWhen, and watchWhen.
   *
   * `undefined` means "not recorded". A predicate that reads an unrecorded fact makes the
   * requirement not_evaluable — an absent value never stands in for a default.
   */
  readonly context: Facts;
}

export interface AssessmentInput {
  readonly subjectId: string;
  readonly gateId: string;
  /** Commitment over the whole evaluation input. Equal values must yield equal results. */
  readonly inputSnapshotHash: string;
  /** Evaluation reference time. Fixed in the snapshot, not the current time. */
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
  /** When false, excluded from aggregation. */
  readonly applicable: boolean;
  readonly reasonCode: RequirementReasonCode;
  /** What is missing — the UI uses this to guide the next action. */
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
    // No facts were supplied. Do not treat this as a pass.
    return {
      ...base,
      status: "not_evaluable",
      applicable: true,
      reasonCode: "FACTS_NOT_SUPPLIED",
      missing: ["requirement_facts"],
    };
  }

  // Whether a requirement applies cannot be decided on a fact nobody recorded. Reading an
  // absent stage as "does not apply" would pass the requirement without looking at it.
  const unknownApplicability = absentFacts(requirement.appliesWhen, facts.context);
  if (unknownApplicability.length > 0) {
    return notEvaluableFor(base, unknownApplicability);
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

  // Having no evaluation basis at all takes precedence over missing evidence. A comparison
  // such as `jurisdictionProfileState = suspended` is false on an absent value, which would
  // read as "not suspended" — so an unrecorded fact is itself a missing basis.
  const unknownBasis = [
    ...absentFacts(requirement.notEvaluableWhen, facts.context),
    ...(requirement.watchWhen === null ? [] : absentFacts(requirement.watchWhen, facts.context)),
  ];
  if (unknownBasis.length > 0) {
    return notEvaluableFor(base, unknownBasis);
  }
  if (evaluatePredicate(requirement.notEvaluableWhen, facts.context)) {
    return notEvaluableFor(base, [...collectPredicatePaths(requirement.notEvaluableWhen)]);
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

  // Stale evidence comes before the grade: the grade was earned on evidence that has since
  // moved, so "grade below minimum" would send people to review the wrong thing.
  const staleClaimTypes = facts.staleEvidence.filter((claimType) =>
    requirement.requiredClaimTypes.includes(claimType),
  );
  if (staleClaimTypes.length > 0) {
    return {
      ...base,
      status: "gap",
      applicable: true,
      reasonCode: "EVIDENCE_STALE",
      missing: [...new Set(staleClaimTypes)].sort().map((claimType) => `stale:${claimType}`),
    };
  }

  if (!hasMinimumGrade(facts, requirement)) {
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

  const freshness = evaluateFreshness(requirement, facts);
  if (freshness !== null) return freshness;

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

function hasMinimumGrade(facts: RequirementFacts, requirement: Requirement): boolean {
  return facts.grade !== null && gradeAtLeast(facts.grade, requirement.minimumGrade);
}

function evaluateFreshness(
  requirement: Requirement,
  facts: RequirementFacts,
): RequirementResult | null {
  const base = { requirementId: requirement.requirementId } as const;
  if (requirement.freshnessThresholdDays !== null) {
    if (facts.evidenceAgeDays === null) {
      // Without the age, freshness cannot be judged. Do not pass it.
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

  return null;
}

/** Fact paths a predicate reads that the context does not carry, sorted and unique. */
function absentFacts(predicate: Predicate, context: Facts): string[] {
  return [...collectPredicatePaths(predicate)].filter((path) => context[path] === undefined).sort();
}

function notEvaluableFor(
  base: { readonly requirementId: string },
  paths: readonly string[],
): RequirementResult {
  return {
    ...base,
    status: "not_evaluable",
    applicable: true,
    reasonCode: "NO_EVALUATION_BASIS",
    missing: [...new Set(paths)].sort().map((path) => `fact:${path}`),
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
 * Canonical commitment of an assessment.
 *
 * The same `(inputSnapshotHash, ruleSetVersion)` always yields the same value. This hash is
 * recorded as a GateDecision input, so "what was the decision based on" can be reproduced later.
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
    // Sort by requirementId to remove any dependence on array order.
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
