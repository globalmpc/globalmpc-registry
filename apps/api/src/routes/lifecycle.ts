import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { atLifecycleMachine, resumeFromSuspension, type AtLifecycleState } from "@mpc/domain";
import { projectLifecycleTransitionRequest } from "@mpc/api-contract";
import { badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Project lifecycle transitions — spec 04 §4.3.
 *
 * `lifecycle_state` enters as `draft`, and the only move was Registry publishing moving it once
 * to `registered`. The other transitions **had no path at all** — the state machine and unit
 * tests existed, but no route called them.
 *
 * **Decision — taking down and bringing up are separated.**
 *
 * - Entering `suspended` is **one-person**. It is urgent; requiring two people would keep a
 *   problematic project running while waiting for the second (same logic as wallet deactivation).
 * - Other transitions are done by `issuer_officer`/`gate_approver`. An operator alone cannot
 *   open an offering.
 * - **Whoever suspended cannot reinstate.** If the same person suspends and reverts, suspension
 *   becomes personal discretion rather than a control.
 *
 * **There are no automatic transitions.** A gate decision result does not move the state — for
 * the same reason readiness is not approval (AC-03). Stale signals do not move it either.
 * A person records a reason and moves it.
 */

interface ProjectRow {
  id: string;
  lifecycle_state: AtLifecycleState;
  prior_lifecycle_state: AtLifecycleState | null;
  suspended_by_subject_id: string | null;
  version: number;
}

interface TransitionRow {
  from_state: string;
  to_state: string;
  reason: string;
  actor_subject_id: string | null;
  occurred_at: Date;
}

export async function registerLifecycleRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  async function readLifecycle(
    tx: postgres.Sql | postgres.TransactionSql,
    tenantId: string,
    projectId: string,
  ) {
    const [project] = await tx<ProjectRow[]>`
      SELECT id, lifecycle_state, prior_lifecycle_state, suspended_by_subject_id, version
      FROM core.projects
      WHERE tenant_id = ${tenantId} AND id = ${projectId}
    `;
    if (!project) throw notFound("Project not found");

    const transitions = await tx<TransitionRow[]>`
      SELECT from_state, to_state, reason, actor_subject_id, occurred_at
      FROM core.project_lifecycle_transitions
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
      ORDER BY occurred_at
    `;

    return {
      projectId: project.id,
      lifecycleState: project.lifecycle_state,
      priorLifecycleState: project.prior_lifecycle_state,
      version: project.version,
      transitions: transitions.map((row) => ({
        fromState: row.from_state,
        toState: row.to_state,
        reason: row.reason,
        actorSubjectId: row.actor_subject_id,
        occurredAt: row.occurred_at.toISOString(),
      })),
      project,
    };
  }

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/lifecycle",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      assertAuthorized(
        session,
        "project.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf } = request.context;
      return withTenant(sql, { tenantId }, async (tx) => {
        const { project: _project, ...view } = await readLifecycle(
          tx,
          tenantId,
          request.params.projectId,
        );
        return { ...view, requestId, asOf };
      });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/lifecycle-transitions",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // If-Match is checked before the body — if a request missing the header got a 400 for the
      // body, the client would keep fixing the body without getting anywhere.
      const expected = requireIfMatch(request);

      const parsed = projectLifecycleTransitionRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const toState = parsed.data.toState as AtLifecycleState;

      /**
       * The asymmetry of 04 §4.3 lives here. The destination determines the permission.
       */
      const effectiveRole = assertAuthorized(
        session,
        toState === "suspended" ? "project.lifecycle.suspend" : "project.lifecycle.advance",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
          const [project] = await tx<ProjectRow[]>`
            SELECT id, lifecycle_state, prior_lifecycle_state, suspended_by_subject_id, version
            FROM core.projects
            WHERE tenant_id = ${tenantId} AND id = ${request.params.projectId}
            FOR UPDATE
          `;
          if (!project) throw notFound("Project not found");
          assertVersionMatches(expected, project.version, "project");

          const from = project.lifecycle_state;
          const allowed = atLifecycleMachine.transitions[from] ?? [];
          if (!allowed.includes(toState)) {
            throw unprocessable("LIFECYCLE_TRANSITION_NOT_ALLOWED", "Transition not allowed", {
              from,
              to: toState,
              allowed: [...allowed],
            });
          }

          /**
           * Reinstatement goes only to the state before suspension, or to closure (§4.3).
           *
           * Reinstating to an arbitrary state would make suspension a way to launder state —
           * suspend, then come out wherever you like.
           */
          if (from === "suspended") {
            if (!resumeFromSuspension(project.prior_lifecycle_state ?? "draft", toState)) {
              throw unprocessable(
                "LIFECYCLE_RESUME_TARGET_INVALID",
                "Reinstatement goes only to the pre-suspension state or closure",
                { priorState: project.prior_lifecycle_state, requested: toState },
              );
            }
            /**
             * Whoever suspended cannot revert.
             *
             * If the same person suspends and reverts, suspension becomes personal discretion rather
             * than a control. Same rule as the "no operator-only transition" of 02 §2.8.
             */
            if (
              project.suspended_by_subject_id !== null &&
              project.suspended_by_subject_id === session.subjectId
            ) {
              throw forbidden(
                "LIFECYCLE_RESUME_SELF",
                "Whoever suspended the project cannot reinstate it",
                { requiredAction: "Another permission holder decides the reinstatement" },
              );
            }
          }

          const [updated] = await tx<ProjectRow[]>`
            UPDATE core.projects
            SET lifecycle_state = ${toState},
                -- Reinstatement target is the pre-suspension state. Cleared on exit.
                prior_lifecycle_state = ${toState === "suspended" ? from : null},
                suspended_by_subject_id = ${toState === "suspended" ? session.subjectId : null},
                version = version + 1,
                updated_at = now()
            WHERE tenant_id = ${tenantId} AND id = ${project.id}
            RETURNING id, lifecycle_state, prior_lifecycle_state, suspended_by_subject_id, version
          `;

          await tx`
            INSERT INTO core.project_lifecycle_transitions (
              tenant_id, project_id, from_state, to_state, reason, actor_subject_id
            ) VALUES (
              ${tenantId}, ${project.id}, ${from}, ${toState},
              ${parsed.data.reason}, ${session.subjectId}
            )
          `;

          await recordAudit(tx, {
            tenantId,
            projectId: project.id,
            session,
            effectiveRole,
            command: `project.lifecycle.${toState}`,
            resourceType: "project",
            resourceId: project.id,
            beforeVersion: project.version,
            afterVersion: updated!.version,
            reason: parsed.data.reason,
            correlationId,
            requestIp: request.ip,
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.lifecycle.transitioned",
            aggregateId: project.id,
            aggregateVersion: updated!.version,
            projectId: project.id,
            payload: { fromState: from, toState },
            correlationId,
          });

          reply.header("etag", etagOf(updated!.version));
          const { project: _project, ...view } = await readLifecycle(tx, tenantId, project.id);
          return { ...view, requestId, asOf };
        }),
      );
    },
  );
}
