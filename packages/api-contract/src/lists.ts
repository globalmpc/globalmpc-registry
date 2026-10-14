import { z } from "zod";
import {
  anchorBatchStatus,
  claim,
  governanceProposal,
  notification,
  objectUpload,
  projectSummary,
  scannerStatus,
  sourceReceipt,
} from "./resources.js";
import { projectListItem } from "./project-registry.js";

/**
 * How much of a capped list came back.
 *
 * These lists used to stop at a fixed row count and say nothing. A project with 10,000
 * documents showed its newest 100 and the screen read as "that is everything". Every capped
 * list now states whether rows were left out, so a screen can say so instead of implying a
 * complete answer.
 *
 * `total` is sent only where counting is one indexed lookup per project. Tenant-wide lists
 * (proposals, notifications, anchor batches) carry the flag without a count.
 */
export const listWindow = {
  /** `true` when rows exist beyond what this response carries. */
  truncated: z.boolean(),
  /** The cap applied to this response. */
  limit: z.number().int().positive(),
};

/** Upload list query. Parameters not listed here are rejected, not ignored. */
export const uploadListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    /** Opaque. Send back the `nextCursor` of the previous page unchanged. */
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * Upload list — the Data Room's document list, newest first.
 *
 * Paged with a keyset cursor over (uploaded time, id). OFFSET would drift as uploads arrive
 * while someone pages; the id breaks ties so no two rows share a position.
 */
export const uploadList = z.object({
  items: objectUpload.array(),
  /** Returned with the list: from the list alone, "waiting" and "nobody to scan" look the same. */
  scanner: scannerStatus,
  nextCursor: z.string().nullable(),
  sort: z.literal("uploadedAt:desc,id:desc"),
  ...listWindow,
  /** Documents in the project, across all pages. */
  total: z.number().int().nonnegative(),
});

/** Document graph query. */
export const documentGraphQuery = z
  .object({
    /**
     * A document whose own node and direct neighbours must be in the payload even when they
     * fall outside the newest ones. The document page needs its own links in full.
     */
    focus: z.string().uuid().optional(),
  })
  .strict();

export const sourceReceiptList = z.object({
  items: sourceReceipt.array(),
  ...listWindow,
  total: z.number().int().nonnegative(),
});

export const claimList = z.object({
  items: claim.array(),
  ...listWindow,
  total: z.number().int().nonnegative(),
});

export const governanceProposalList = z.object({
  items: governanceProposal.array(),
  ...listWindow,
});

export const notificationList = z.object({
  items: notification.array(),
  ...listWindow,
});

export const anchorBatchStatusList = z.object({
  items: anchorBatchStatus.array(),
  ...listWindow,
});

export const projectSummaryList = z.object({
  items: projectSummary.array(),
  ...listWindow,
});

/** Project List (11 §11.3) — the filtered list, capped, most recently updated first. */
export const projectListItemList = z.object({
  items: projectListItem.array(),
  ...listWindow,
});
