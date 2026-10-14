import type {
  DocumentListFilter,
  DocumentRequirementTier,
  DocumentStatus,
  RequirementStatus,
} from "@/lib/api";

/**
 * Wording for the document status screen.
 *
 * Kept in one place so a tier or a status reads the same in the summary, the requirement table
 * and the document list.
 */

export const TIER_LABEL: Record<DocumentRequirementTier, string> = {
  required: "Required",
  user_benefit: "Helps readers",
  presentation: "Presentation",
  management: "Management",
};

/** Why a tier exists. Shown next to the choice, so people pick by meaning, not by name. */
export const TIER_EXPLANATION: Record<DocumentRequirementTier, string> = {
  required: "The project is incomplete without it.",
  user_benefit: "Not required; it helps the people reading the project.",
  presentation: "Not required; it makes the project easier to present.",
  management: "Not required; it makes the project easier to run.",
};

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  current: "Current",
  expired: "Expired",
  superseded: "Replaced by a newer version",
  pending: "Not promoted yet",
  unusable: "Failed scanning or rejected",
};

export const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  met: "Met",
  expired: "Only expired copies",
  pending: "Only copies not promoted yet",
  missing: "Missing",
};

/**
 * Glyph next to a requirement status. Never colour alone (§11.8); the glyph is decorative and
 * the label carries the meaning.
 */
export const REQUIREMENT_STATUS_GLYPH: Record<RequirementStatus, string> = {
  met: "✓",
  expired: "!",
  pending: "◷",
  missing: "✕",
};

export const TIERS: readonly DocumentRequirementTier[] = [
  "required",
  "user_benefit",
  "presentation",
  "management",
];

export const STATUSES: readonly DocumentStatus[] = [
  "current",
  "expired",
  "superseded",
  "pending",
  "unusable",
];

/**
 * Filter changes that keep the list answerable.
 *
 * The server reads an expiry window only among current documents. A window kept beside another
 * status would return nothing and say nothing, so choosing one clears the other.
 */
export function withStatusFilter(
  filter: DocumentListFilter,
  status: DocumentStatus | undefined,
): DocumentListFilter {
  const keepsWindow = status === undefined || status === "current";
  return {
    ...filter,
    status,
    expiresWithinDays: keepsWindow ? filter.expiresWithinDays : undefined,
  };
}

export function withExpiryWindow(
  filter: DocumentListFilter,
  days: number | undefined,
): DocumentListFilter {
  const keepsStatus = days === undefined || filter.status === undefined || filter.status === "current";
  return { ...filter, expiresWithinDays: days, status: keepsStatus ? filter.status : undefined };
}
