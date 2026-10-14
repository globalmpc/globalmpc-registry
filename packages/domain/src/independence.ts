/**
 * Reviewer independence — spec 02 §2.4 rules 1·2, §2.8, REQ-DAPP-018·044.
 *
 * The server judges independence from recorded facts; the assigner's declaration
 * (`conflictStatus`) is a separate disclosure and cannot waive a rule.
 *
 * Two outcomes are kept apart:
 *
 * - a **violation** — the facts show the rule is broken. The assignment is refused.
 * - **not evaluable** — a fact the rule needs is missing (a claim with no recorded submitter, a
 *   reviewer with no organization on record). The assignment may exist, but it is not marked
 *   reviewed and cannot be signed on. "We could not check" must never read as "independent".
 */

export type IndependenceViolation =
  /** 02 §2.8: the assigner appoints themselves, then signs — self-assignment then self-approval. */
  | "SELF_ASSIGNMENT"
  /** Rule 1: the reviewer submitted evidence in the case under review. */
  | "REVIEWER_SUBMITTED_EVIDENCE"
  /** Rule 2: the reviewer belongs to the organization that operates the project. */
  | "REVIEWER_SHARES_OPERATOR_ORGANIZATION";

export type IndependenceGap =
  | "EVIDENCE_SUBMITTER_UNKNOWN"
  | "REVIEWER_ORGANIZATION_UNKNOWN"
  | "OPERATOR_ORGANIZATION_UNKNOWN";

export interface IndependenceFacts {
  readonly reviewerSubjectId: string;
  readonly assignerSubjectId: string | null;
  /** Subjects recorded as submitting the evidence under review. */
  readonly evidenceSubmitterIds: readonly string[];
  /** False when some evidence item has no recorded submitter. */
  readonly allSubmittersKnown: boolean;
  /** Organizations the reviewer acts for — credential organization and active role bindings. */
  readonly reviewerOrganizationIds: readonly string[];
  /** Organizations operating the project. */
  readonly operatorOrganizationIds: readonly string[];
}

export interface IndependenceReview {
  /** True only when no rule is violated and nothing was left unevaluated. */
  readonly reviewed: boolean;
  readonly violations: readonly IndependenceViolation[];
  readonly gaps: readonly IndependenceGap[];
}

export function reviewIndependence(facts: IndependenceFacts): IndependenceReview {
  const violations: IndependenceViolation[] = [];
  const gaps: IndependenceGap[] = [];

  if (facts.assignerSubjectId !== null && facts.assignerSubjectId === facts.reviewerSubjectId) {
    violations.push("SELF_ASSIGNMENT");
  }

  // Rule 1. A known submitter match is a violation even when other submitters are unknown.
  if (facts.evidenceSubmitterIds.includes(facts.reviewerSubjectId)) {
    violations.push("REVIEWER_SUBMITTED_EVIDENCE");
  } else if (!facts.allSubmittersKnown) {
    gaps.push("EVIDENCE_SUBMITTER_UNKNOWN");
  }

  // Rule 2. "Control relationships" beyond the same organization have no record to check yet;
  // the same-organization case is the part that can be checked.
  if (facts.reviewerOrganizationIds.some((id) => facts.operatorOrganizationIds.includes(id))) {
    violations.push("REVIEWER_SHARES_OPERATOR_ORGANIZATION");
  } else {
    if (facts.reviewerOrganizationIds.length === 0) gaps.push("REVIEWER_ORGANIZATION_UNKNOWN");
    if (facts.operatorOrganizationIds.length === 0) gaps.push("OPERATOR_ORGANIZATION_UNKNOWN");
  }

  return { reviewed: violations.length === 0 && gaps.length === 0, violations, gaps };
}
