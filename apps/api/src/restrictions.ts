import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { checkRestrictedAction, type DisclosureRestriction } from "@mpc/domain";
import { AppError } from "./errors.js";
import { enqueueEvent } from "./outbox.js";

/**
 * Material-information blackout enforcement — 07 §7.14, AC-30.
 *
 * Hiding a button is not a control. Every route that performs an action a restriction can name
 * calls `assertActionNotRestricted` inside its transaction, after locking what it changes, so a
 * restriction activated a moment earlier is seen.
 *
 * The domain decides (`checkRestrictedAction`); this file only loads the active restrictions and
 * turns a block into the error every caller shares — the same restriction ID in the API
 * response, the UI, and the history.
 */

export const DISCLOSURE_RESTRICTED = "DISCLOSURE_RESTRICTED";

interface ActiveRestrictionRow {
  readonly id: string;
  readonly subject_scope: string[];
  readonly restricted_action_types: string[];
  readonly reason: string | null;
  readonly authority: string;
  readonly effective_at: Date | null;
  readonly expected_next_update_at: Date | null;
}

/**
 * Transaction-scoped lock on a project's restrictions.
 *
 * Taken by every guarded action before it reads the active restrictions, and by every
 * restriction transition before it changes one. Under READ COMMITTED the read that follows the
 * lock sees a transition committed while waiting.
 */
export async function lockProjectRestrictions(
  tx: postgres.TransactionSql,
  tenantId: string,
  projectId: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`disclosure:${tenantId}:${projectId}`}, 0))`;
}

/**
 * Refuses `action` while an active restriction on the project covers it.
 *
 * A restriction covers a subject when its scope names the project (everyone) or the acting
 * subject (a designated insider, J-22 step 3). Both are checked; the first match is reported.
 *
 * Rejects with 409 and `retryable: false` — retrying does not help until a person records a
 * release. The details carry what 11 §11.12 asks the screen to show next to the action.
 */
export async function assertActionNotRestricted(
  tx: postgres.TransactionSql,
  tenantId: string,
  projectId: string,
  action: string,
  actorSubjectId: string | null = null,
): Promise<void> {
  // Serializes with restriction transitions on this project (`lockProjectRestrictions`). Without
  // it, a check that read no active restriction could commit after an activation it did not see.
  await lockProjectRestrictions(tx, tenantId, projectId);
  const rows = await tx<ActiveRestrictionRow[]>`
    SELECT id, subject_scope::text[] AS subject_scope, restricted_action_types, reason,
           authority, effective_at, expected_next_update_at
    FROM core.disclosure_restrictions
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND state = 'active'
    ORDER BY effective_at, id
  `;
  if (rows.length === 0) return;

  const restrictions: DisclosureRestriction[] = rows.map((row) => ({
    restrictionId: row.id,
    subjectScope: row.subject_scope,
    restrictedActionTypes: row.restricted_action_types,
    state: "active",
  }));

  const subjects = actorSubjectId ? [projectId, actorSubjectId] : [projectId];
  for (const subject of subjects) {
    const check = checkRestrictedAction(restrictions, subject, action);
    if (!check.blocked) continue;

    const row = rows.find((candidate) => candidate.id === check.restrictionId)!;
    throw new AppError(
      DISCLOSURE_RESTRICTED,
      "This action is restricted by an active material-information blackout",
      409,
      false,
      {
        restrictionId: row.id,
        projectId,
        actionType: action,
        reason: row.reason,
        authority: row.authority,
        effectiveAt: row.effective_at?.toISOString() ?? null,
        expectedNextUpdateAt: row.expected_next_update_at?.toISOString() ?? null,
        nextAction: "Wait for the restriction to be released by its authority",
      },
    );
  }
}

/**
 * Keeps every blocked attempt — J-22 step 5, AC-30.
 *
 * The block rolls back the route's transaction, so the attempt cannot be written there. It is
 * written here, in its own transaction, before the error response is sent (Fastify runs
 * `onError` hooks before the error handler replies). A failure to record is logged, not
 * surfaced: the refusal itself must reach the caller either way.
 */
export function registerBlockedAttemptRecorder(app: FastifyInstance, sql: postgres.Sql): void {
  app.addHook("onError", async (request, _reply, error) => {
    if (!(error instanceof AppError) || error.code !== DISCLOSURE_RESTRICTED) return;
    const tenantId = request.session?.tenantId;
    const details = error.details ?? {};
    if (!tenantId) return;

    try {
      await withTenant(sql, { tenantId }, async (tx) => {
        const restrictionId = String(details["restrictionId"]);
        const projectId = String(details["projectId"]);
        const actionType = String(details["actionType"]);
        const correlationId = request.context?.correlationId ?? "unknown";

        await tx`
          INSERT INTO core.disclosure_restriction_events (
            tenant_id, restriction_id, project_id, event_kind, action_type,
            actor_subject_id, correlation_id
          ) VALUES (
            ${tenantId}, ${restrictionId}, ${projectId}, 'blocked_attempt', ${actionType},
            ${request.session?.subjectId ?? null}, ${correlationId}
          )
        `;

        await enqueueEvent(tx, {
          tenantId,
          eventType: "disclosure.blackout.blocked_action",
          aggregateId: restrictionId,
          aggregateVersion: 1,
          projectId,
          correlationId,
          payload: { actionType },
        });
      });
    } catch (recordError) {
      request.log.error({ err: recordError }, "failed to record a blocked blackout attempt");
    }
  });
}
