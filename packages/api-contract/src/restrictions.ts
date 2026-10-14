import { z } from "zod";
import { RESTRICTABLE_ACTION_TYPES, SOURCE_RESULTS } from "@mpc/domain";
import { isoDateTime } from "./common.js";
import type { RouteDefinition } from "./routes.js";

/**
 * Material-information blackout and source reconciliation — 07 §7.14, 04 §4.9, AC-19, AC-30.
 *
 * Kept in its own module: these routes are added together, and a separate file keeps their
 * schemas next to the routes that use them.
 */

/**
 * Create a restriction — always starts as `draft`.
 *
 * `restrictedActionTypes` accepts only actions that have a check behind them
 * (`RESTRICTABLE_ACTION_TYPES`). A restriction naming an unchecked action would read as a
 * control that does not exist.
 */
export const disclosureRestrictionCreateRequest = z.object({
  /** Subjects the blackout covers — the project itself, or specific insiders by subject id. */
  subjectScope: z.array(z.string().uuid()).min(1),
  restrictedActionTypes: z.array(z.enum(RESTRICTABLE_ACTION_TYPES)).min(1),
  materialInfoRef: z.string().min(1).max(500),
  reason: z.string().min(1).max(1000),
  legalBasis: z.string().min(1).max(1000),
  authority: z.string().min(1).max(500),
  expectedNextUpdateAt: isoDateTime.nullable().optional(),
  expectedReleaseAt: isoDateTime.nullable().optional(),
});

export const disclosureRestrictionActivateRequest = z.object({
  reason: z.string().min(1).max(1000),
});

/**
 * The release record — J-22 step 4.
 *
 * Nothing releases a blackout except a person recording these three things. There is no
 * time-based release.
 */
export const disclosureRestrictionReleaseRequest = z.object({
  /** Where the material information was disclosed (filing, notice, publication reference). */
  disclosureReference: z.string().min(1).max(1000),
  /** The legal or contractual condition that now permits the actions again. */
  legalCondition: z.string().min(1).max(1000),
  reason: z.string().min(1).max(1000),
});

export const disclosureRestrictionSupersedeRequest = z.object({
  reason: z.string().min(1).max(1000),
  /** The restriction that replaces this one, when there is one. */
  supersededById: z.string().uuid().nullable().optional(),
});

export const disclosureRestriction = z.object({
  restrictionId: z.string(),
  projectId: z.string(),
  state: z.enum(["draft", "active", "released", "superseded"]),
  subjectScope: z.array(z.string()),
  restrictedActionTypes: z.array(z.string()),
  materialInfoRef: z.string().nullable(),
  reason: z.string().nullable(),
  legalBasis: z.string(),
  authority: z.string(),
  effectiveAt: isoDateTime.nullable(),
  expectedNextUpdateAt: isoDateTime.nullable(),
  expectedReleaseAt: isoDateTime.nullable(),
  releasedAt: isoDateTime.nullable(),
  releaseRecord: z.record(z.unknown()).nullable(),
  supersededById: z.string().nullable(),
  version: z.number().int().positive(),
  /** Activation, blocked attempts, release — never deleted (J-22 step 5). */
  history: z.array(
    z.object({
      eventKind: z.enum(["created", "activated", "blocked_attempt", "released", "superseded"]),
      actionType: z.string().nullable(),
      actorSubjectId: z.string().nullable(),
      reason: z.string().nullable(),
      occurredAt: isoDateTime,
    }),
  ),
});

export const disclosureRestrictionList = z.object({
  items: z.array(disclosureRestriction),
});

/** A reconciliation task — the adapter-health `reconciliation_required` signal (AC-19). */
export const sourceReconciliationTask = z.object({
  taskId: z.string(),
  connectionId: z.string(),
  receiptId: z.string(),
  triggerResult: z.enum(SOURCE_RESULTS),
  state: z.enum(["open", "resolved"]),
  openedAt: isoDateTime,
  resolvedAt: isoDateTime.nullable(),
  resolvedBy: z.string().nullable(),
  resolution: z.string().nullable(),
  version: z.number().int().positive(),
});

export const sourceReconciliationTaskList = z.object({
  items: z.array(sourceReconciliationTask),
});

export const resolveReconciliationTaskRequest = z.object({
  /** What was compared and found — required. A pause lifted without a reason is not a reconciliation. */
  resolution: z.string().min(1).max(2000),
});

/** One recorded stage change of a connection — R5 gate item 8 evidence. */
export const sourceConnectionTransition = z.object({
  fromState: z.string().nullable(),
  toState: z.string(),
  actorSubjectId: z.string().nullable(),
  reason: z.string(),
  occurredAt: isoDateTime,
});

export const sourceConnectionTransitionList = z.object({
  items: z.array(sourceConnectionTransition),
});

export const RESTRICTION_ROUTES: readonly RouteDefinition[] = [
  // --- Material-information blackout (07 §7.14) -----------------------------
  {
    method: "post",
    path: "/api/v1/projects/{projectId}/disclosure-restrictions",
    summary: "Create a disclosure restriction — starts as draft and blocks nothing yet",
    operationId: "createDisclosureRestriction",
    public: false,
    mutation: true,
    requiresIfMatch: false,
    action: "disclosure.restrict",
    implemented: true,
    requestSchema: disclosureRestrictionCreateRequest,
    responseSchema: disclosureRestriction,
  },
  {
    method: "get",
    path: "/api/v1/projects/{projectId}/disclosure-restrictions",
    summary: "List disclosure restrictions with their activation, blocked-attempt and release history",
    operationId: "listDisclosureRestrictions",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: null,
    implemented: true,
    responseSchema: disclosureRestrictionList,
  },
  {
    method: "get",
    path: "/api/v1/projects/{projectId}/disclosure-restrictions/active",
    summary: "Active blackouts — what is restricted, why, by whom, since when",
    operationId: "listActiveDisclosureRestrictions",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: null,
    implemented: true,
    responseSchema: disclosureRestrictionList,
  },
  {
    method: "post",
    path: "/api/v1/disclosure-restrictions/{restrictionId}/activate",
    summary: "Activate a blackout — the named actions are refused with this restriction ID",
    operationId: "activateDisclosureRestriction",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "disclosure.restrict",
    implemented: true,
    requestSchema: disclosureRestrictionActivateRequest,
    responseSchema: disclosureRestriction,
  },
  {
    method: "post",
    path: "/api/v1/disclosure-restrictions/{restrictionId}/release",
    summary: "Release a blackout — only with a release record; never released automatically",
    operationId: "releaseDisclosureRestriction",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "disclosure.restrict",
    implemented: true,
    requestSchema: disclosureRestrictionReleaseRequest,
    responseSchema: disclosureRestriction,
  },
  {
    method: "post",
    path: "/api/v1/disclosure-restrictions/{restrictionId}/supersede",
    summary: "Supersede a restriction — its scope is replaced by another record, not edited",
    operationId: "supersedeDisclosureRestriction",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "disclosure.restrict",
    implemented: true,
    requestSchema: disclosureRestrictionSupersedeRequest,
    responseSchema: disclosureRestriction,
  },

  // --- Source reconciliation and stage evidence (04 §4.9, AC-19) -------------
  {
    method: "get",
    path: "/api/v1/source-connections/{connectionId}/reconciliation-tasks",
    summary: "Reconciliation tasks — opened when a source result degrades the connection",
    operationId: "listSourceReconciliationTasks",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: null,
    implemented: true,
    responseSchema: sourceReconciliationTaskList,
  },
  {
    method: "post",
    path: "/api/v1/source-reconciliation-tasks/{taskId}/resolve",
    summary: "Resolve a reconciliation task — required before a degraded connection returns to active",
    operationId: "resolveSourceReconciliationTask",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "connection.configure",
    implemented: true,
    requestSchema: resolveReconciliationTaskRequest,
    responseSchema: sourceReconciliationTask,
  },
  {
    method: "get",
    path: "/api/v1/source-connections/{connectionId}/transitions",
    summary: "Connection stage history — when each integration stage was reached, by whom, and why",
    operationId: "listSourceConnectionTransitions",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: null,
    implemented: true,
    responseSchema: sourceConnectionTransitionList,
  },
];
