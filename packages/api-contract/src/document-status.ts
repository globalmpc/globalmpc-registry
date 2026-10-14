import { z } from "zod";
import {
  DOCUMENT_REQUIREMENT_TIERS,
  DOCUMENT_STATUSES,
  REQUIREMENT_STATUSES,
} from "@mpc/domain";
import { isoDateTime } from "./common.js";

/**
 * Document status — which documents a project expects, and where its documents stand.
 *
 * A project can hold thousands of documents, so the summary is counted on the server and the
 * list is paged. No list here stops silently at a fixed size: the list pages with a cursor, and
 * the one capped section of the summary says when it was cut.
 */

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const documentTypeText = z.string().trim().min(1).max(80);

export const documentRequirementTier = z.enum(DOCUMENT_REQUIREMENT_TIERS);
export const documentStatus = z.enum(DOCUMENT_STATUSES);
export const documentRequirementStatus = z.enum(REQUIREMENT_STATUSES);

/** A document type the project expects, and how much it matters. */
export const documentRequirement = z.object({
  id: z.string(),
  projectId: z.string(),
  documentType: z.string(),
  tier: documentRequirementTier,
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  retiredAt: isoDateTime.nullable(),
  retirementNote: z.string().nullable(),
});

/**
 * Declare a type the project expects.
 *
 * Types match uploads case-insensitively. To move a type to another tier, retire the current
 * declaration and declare it again — the earlier one stays on record.
 */
export const createDocumentRequirementRequest = z
  .object({
    documentType: documentTypeText,
    tier: documentRequirementTier,
    note: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();

export const retireDocumentRequirementRequest = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

export const documentRequirementList = z.object({
  /** Active declarations only. Retired ones stay in the database for the record. */
  items: documentRequirement.array(),
});

/** A declared type with the documents that match it. */
export const documentRequirementProgress = z.object({
  requirement: documentRequirement,
  status: documentRequirementStatus,
  currentCount: z.number().int().nonnegative(),
  expiredCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  supersededCount: z.number().int().nonnegative(),
  /** Earliest last valid day among the current documents. `null` when none has a date. */
  nearestValidUntil: calendarDate.nullable(),
  daysUntilExpiry: z.number().int().nullable(),
});

export const documentStatusSummary = z.object({
  projectId: z.string(),
  /** The calendar day expiry is judged against — the database's, as the expiry sweep uses. */
  today: calendarDate,
  totals: z.object({
    all: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    unusable: z.number().int().nonnegative(),
    /** Current or expired documents nobody gave a type. They cannot count toward any requirement. */
    untyped: z.number().int().nonnegative(),
    /** Current documents with no last valid day. They never expire here. */
    withoutValidUntil: z.number().int().nonnegative(),
    openImpacts: z.number().int().nonnegative(),
  }),
  tiers: z.array(
    z.object({
      tier: documentRequirementTier,
      declared: z.number().int().nonnegative(),
      met: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      /** A required type is not met. Never true for the other tiers. */
      incomplete: z.boolean(),
    }),
  ),
  requirements: documentRequirementProgress.array(),
  /** Types present in the project that nobody declared, most documents first. */
  undeclaredTypes: z.array(
    z.object({
      documentType: z.string(),
      currentCount: z.number().int().nonnegative(),
      expiredCount: z.number().int().nonnegative(),
      supersededCount: z.number().int().nonnegative(),
      pendingCount: z.number().int().nonnegative(),
    }),
  ),
  /** More undeclared types exist than were returned. */
  undeclaredTypesTruncated: z.boolean(),
  /** Current documents closest to their last valid day. No warning threshold is applied. */
  nextExpiries: z.array(
    z.object({
      uploadId: z.string(),
      documentType: z.string().nullable(),
      validUntil: calendarDate,
      daysUntilExpiry: z.number().int(),
    }),
  ),
});

/** Parameters outside the contract are rejected, not ignored — a mistyped filter is not "all". */
export const documentListQuery = z
  .object({
    status: documentStatus.optional(),
    /** Case-insensitive. */
    documentType: documentTypeText.optional(),
    /** `undeclared` — documents whose type no active requirement names, untyped ones included. */
    tier: z.union([documentRequirementTier, z.literal("undeclared")]).optional(),
    /** Current documents whose last valid day is within this many days. There is no default. */
    expiresWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const documentListItem = z.object({
  uploadId: z.string(),
  /** Restricted, as on the upload itself. Never reaches a public projection. */
  originalFilename: z.string().nullable(),
  state: z.string(),
  status: documentStatus,
  documentType: z.string().nullable(),
  /** Tier of the active requirement naming this type, `null` when none does. */
  tier: documentRequirementTier.nullable(),
  validUntil: calendarDate.nullable(),
  daysUntilExpiry: z.number().int().nullable(),
  supersededByUploadId: z.string().nullable(),
  openImpactCount: z.number().int().nonnegative(),
  uploadedAt: isoDateTime,
  version: z.number().int().positive(),
});

export const documentList = z.object({
  items: documentListItem.array(),
  /** `null` on the last page. */
  nextCursor: z.string().nullable(),
});
