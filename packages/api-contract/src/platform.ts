import { z } from "zod";
import { isoDateTime } from "./common.js";

/**
 * Platform security resources — break-glass elevation (02 §2.6) and source connection security
 * review (02 §2.8).
 */

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank");

/**
 * Break-glass elevation — 02 §2.6.
 *
 * `effective` is decided by the server from state, expiry and the incident deadline, so a screen
 * never has to redo that arithmetic — an elevation shown as live after its expiry would invite
 * someone to act on it.
 */
export const breakGlassElevation = z.object({
  id: z.string(),
  subjectId: z.string(),
  purpose: z.string(),
  target: z.string(),
  requestedAt: isoDateTime,
  expiresAt: isoDateTime,
  state: z.enum(["pending", "active", "rejected", "released"]),
  /** Whether the elevation grants the `break_glass` role right now. */
  effective: z.boolean(),
  decidedBySubjectId: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionReason: z.string().nullable(),
  /** 24 hours after approval (02 §2.6). Null until approved. */
  incidentDueAt: isoDateTime.nullable(),
  /** Approved, the deadline has passed, and no incident record exists. */
  incidentOverdue: z.boolean(),
  incidentReference: z.string().nullable(),
  incidentSummary: z.string().nullable(),
  incidentRecordedAt: isoDateTime.nullable(),
  releaseCause: z.string().nullable(),
  releaseRecoveryVerification: z.string().nullable(),
  releasedBySubjectId: z.string().nullable(),
  releasedAt: isoDateTime.nullable(),
  version: z.number().int().positive(),
});

/**
 * Request an elevation for yourself. Purpose, target and expiry are required (02 §2.6).
 *
 * No maximum duration is imposed here: 02 §2.6 requires an expiry but sets no ceiling, and a
 * number chosen by the implementer would become the policy. The approver sees the expiry and
 * decides.
 */
export const requestBreakGlassRequest = z.object({
  purpose: nonBlank(2000),
  target: nonBlank(500),
  expiresAt: isoDateTime,
});

export const decideBreakGlassRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: nonBlank(1000),
});

export const recordBreakGlassIncidentRequest = z.object({
  /** Identifier of the incident in the incident process (ticket, report number). */
  incidentReference: nonBlank(200),
  summary: nonBlank(4000),
});

/** 02 §2.6: release records the cause, the recovery verification and who approved it. */
export const releaseBreakGlassRequest = z.object({
  cause: nonBlank(2000),
  recoveryVerification: nonBlank(2000),
});

/** Access quarantine: every active role binding of the subject ends at once. */
export const quarantineAccessRequest = z.object({
  subjectId: z.string().guid(),
  reason: nonBlank(1000),
});

export const quarantineAccessResult = z.object({
  subjectId: z.string(),
  elevationId: z.string(),
  revokedBindingIds: z.array(z.string()),
});

/**
 * Connection security review — 02 §2.8.
 *
 * Covers exactly `connectionVersion`. A later configuration change produces a new version,
 * which needs its own review before activation.
 */
export const connectionSecurityReview = z.object({
  id: z.string(),
  connectionId: z.string(),
  connectionVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string(),
  reviewedBySubjectId: z.string(),
  reviewedAt: isoDateTime,
});

export const createConnectionSecurityReviewRequest = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: nonBlank(2000),
});
