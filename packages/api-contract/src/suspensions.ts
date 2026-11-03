import { z } from "zod";
import { ACCOUNT_RECOVERY_SEPARATION_REQUIRED } from "./accounts.js";
import { isoDateTime } from "./common.js";
import type { RouteDefinition } from "./routes.js";

/**
 * Suspending a person — account authentication plan journey 6, AUTH-06 (migration 0127).
 *
 * Two people with an admin role, neither of them the person. Approving a suspension ends every
 * session and revokes every second factor, recovery code and linked Google / Microsoft identity in
 * one transaction; signing in then answers exactly as for an unknown address or identity. Signed
 * history, role bindings and wallets are kept. Reinstating takes the same two people, keeps the
 * recovery separation of 0118 (it opens a 24-hour first-enrolment window, like an MFA reset) and
 * lets the person sign in by email code again.
 */

export const SUBJECT_SUSPENSION_ACTIONS = ["suspend", "reinstate"] as const;

export const subjectSuspension = z.object({
  id: z.string(),
  subjectId: z.string(),
  subjectName: z.string(),
  action: z.enum(SUBJECT_SUSPENSION_ACTIONS),
  reason: z.string(),
  requestedBySubjectId: z.string(),
  requestedAt: isoDateTime,
  state: z.enum(["pending", "approved", "rejected"]),
  decidedBySubjectId: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionReason: z.string().nullable(),
  /** Reinstatement only: until when the person may enrol a first factor after signing in. */
  enrolmentWindowUntil: isoDateTime.nullable(),
  /** `proposer_suspended` when the proposer's own suspension closed it (`rejected`). */
  closedReason: z.enum(["proposer_suspended"]).nullable(),
  version: z.number().int().positive(),
});

export const subjectSuspensionList = z.object({
  items: z.array(subjectSuspension),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const createSubjectSuspensionRequest = z.object({
  subjectId: z.string().guid(),
  action: z.enum(SUBJECT_SUSPENSION_ACTIONS),
  reason: z.string().trim().min(1).max(2000),
});

export const decideSubjectSuspensionRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(2000),
});

/** Suspending someone already suspended, or reinstating someone who is not. */
export const SUSPENSION_STATE_CONFLICT = "SUSPENSION_STATE_CONFLICT";

export const SUSPENSION_ROUTES: readonly RouteDefinition[] = [
  {
    method: "get",
    path: "/api/v1/admin/subject-suspensions",
    summary: "List suspension and reinstatement requests",
    operationId: "listSubjectSuspensions",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: "admin.read",
    implemented: true,
    responseSchema: subjectSuspensionList,
  },
  {
    method: "post",
    path: "/api/v1/admin/subject-suspensions",
    summary: "Propose suspending or reinstating a person — approved by someone else",
    operationId: "createSubjectSuspension",
    public: false,
    mutation: true,
    requiresIfMatch: false,
    action: "admin.subject_suspension.propose",
    implemented: true,
    refusals: [ACCOUNT_RECOVERY_SEPARATION_REQUIRED, SUSPENSION_STATE_CONFLICT],
    requestSchema: createSubjectSuspensionRequest,
    responseSchema: subjectSuspension,
  },
  {
    method: "post",
    path: "/api/v1/admin/subject-suspensions/{suspensionId}/decision",
    summary: "Approve or reject a suspension or reinstatement — not by the proposer or the person",
    operationId: "decideSubjectSuspension",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "admin.subject_suspension.approve",
    implemented: true,
    refusals: [ACCOUNT_RECOVERY_SEPARATION_REQUIRED, SUSPENSION_STATE_CONFLICT],
    requestSchema: decideSubjectSuspensionRequest,
    responseSchema: subjectSuspension,
  },
];
