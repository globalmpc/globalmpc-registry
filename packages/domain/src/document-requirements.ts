/**
 * Document requirements — which document types a project expects, and where each one stands.
 *
 * The list of expected types belongs to the project (migration 0071): no type is required by
 * default, because no catalog of document types has been settled (OD-46). This module only
 * says what a declared type's documents add up to.
 */

/**
 * How much a declared document type matters.
 *
 * Only `required` can leave a project incomplete. The other three say why a document is worth
 * having without making its absence a gap.
 */
export const DOCUMENT_REQUIREMENT_TIERS = [
  "required",
  "user_benefit",
  "presentation",
  "management",
] as const;
export type DocumentRequirementTier = (typeof DOCUMENT_REQUIREMENT_TIERS)[number];

/** Where one upload stands. Computed by the `core.document_status` view. */
export const DOCUMENT_STATUSES = [
  "current",
  "expired",
  "superseded",
  "pending",
  "unusable",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const REQUIREMENT_STATUSES = ["met", "expired", "pending", "missing"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Documents of one declared type, by status. Replaced and unusable ones cover nothing. */
export interface RequirementCounts {
  readonly current: number;
  readonly expired: number;
  readonly pending: number;
}

/**
 * Whether a declared type is covered.
 *
 * - `met`     — at least one current document. Older expired copies do not matter.
 * - `expired` — promoted documents exist but all have passed their date. A renewal still in
 *               quarantine does not change this: nobody can rely on it yet.
 * - `pending` — only documents that are not promoted yet.
 * - `missing` — nothing of the type.
 */
export function requirementStatus(counts: RequirementCounts): RequirementStatus {
  for (const value of [counts.current, counts.expired, counts.pending]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`Document counts are whole numbers from zero, got ${value}`);
    }
  }
  if (counts.current > 0) return "met";
  if (counts.expired > 0) return "expired";
  if (counts.pending > 0) return "pending";
  return "missing";
}

export interface TierSummary {
  readonly tier: DocumentRequirementTier;
  readonly declared: number;
  readonly met: number;
  readonly expired: number;
  readonly pending: number;
  readonly missing: number;
  /** A required type is not met. Never true for the other tiers. */
  readonly incomplete: boolean;
}

/** Counts per tier, every tier listed so an empty one reads as "none declared", not as absent. */
export function summarizeTiers(
  requirements: readonly { readonly tier: DocumentRequirementTier; readonly status: RequirementStatus }[],
): TierSummary[] {
  return DOCUMENT_REQUIREMENT_TIERS.map((tier) => {
    const statuses = requirements
      .filter((requirement) => requirement.tier === tier)
      .map((requirement) => requirement.status);
    const count = (status: RequirementStatus) => statuses.filter((value) => value === status).length;
    const met = count("met");
    return {
      tier,
      declared: statuses.length,
      met,
      expired: count("expired"),
      pending: count("pending"),
      missing: count("missing"),
      incomplete: tier === "required" && met < statuses.length,
    };
  });
}
