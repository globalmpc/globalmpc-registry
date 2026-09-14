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
 * project lifecycle 전이 — spec 04 §4.3.
 *
 * `lifecycle_state`는 `draft`로 들어온 뒤 Registry 게시가 `registered`로 한 번
 * 옮기는 것이 전부였다. 나머지 전이는 **경로 자체가 없었다** — 상태기계와 단위
 * 테스트는 있었고 그것을 호출하는 route가 없었다.
 *
 * **결정 — 내리는 것과 올리는 것을 나눈다.**
 *
 * - `suspended` 진입은 **1인**이다. 급한 일이며, 2인을 요구하면 두 번째 사람을
 *   기다리는 동안 문제가 있는 프로젝트가 계속 돈다(지갑 비활성과 같은 논리).
 * - 나머지 전이는 `issuer_officer`·`gate_approver`가 한다. 운영자 단독으로
 *   offering을 열 수 없다.
 * - **복귀는 멈춘 사람이 할 수 없다.** 같은 사람이 멈추고 되돌리면 suspension이
 *   통제가 아니라 개인의 재량이 된다.
 *
 * **자동 전이는 없다.** gate decision 결과가 상태를 옮기지 않는다 — readiness가
 * 승인이 아닌 것과 같은 이유다(AC-03). stale 신호도 옮기지 않는다.
 * 사람이 이유를 적고 옮긴다.
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
    if (!project) throw notFound("프로젝트를 찾을 수 없다");

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
      // If-Match를 본문보다 먼저 본다 — 헤더가 빠진 요청이 400으로 답하면
      // 클라이언트는 본문을 고치며 헤어나지 못한다.
      const expected = requireIfMatch(request);

      const parsed = projectLifecycleTransitionRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }
      const toState = parsed.data.toState as AtLifecycleState;

      /**
       * 04 §4.3의 비대칭이 여기 있다. 목적지가 권한을 정한다.
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
          if (!project) throw notFound("프로젝트를 찾을 수 없다");
          assertVersionMatches(expected, project.version, "project");

          const from = project.lifecycle_state;
          const allowed = atLifecycleMachine.transitions[from] ?? [];
          if (!allowed.includes(toState)) {
            throw unprocessable("LIFECYCLE_TRANSITION_NOT_ALLOWED", "허용되지 않은 전이다", {
              from,
              to: toState,
              allowed: [...allowed],
            });
          }

          /**
           * 복귀는 suspend 직전 상태 또는 closure로만 간다(§4.3).
           *
           * 임의 상태로 복귀하면 suspension이 상태를 세탁하는 수단이 된다 —
           * 멈췄다가 원하는 자리로 나오는 것이다.
           */
          if (from === "suspended") {
            if (!resumeFromSuspension(project.prior_lifecycle_state ?? "draft", toState)) {
              throw unprocessable(
                "LIFECYCLE_RESUME_TARGET_INVALID",
                "suspension 직전 상태 또는 closure로만 복귀한다",
                { priorState: project.prior_lifecycle_state, requested: toState },
              );
            }
            /**
             * 멈춘 사람은 되돌릴 수 없다.
             *
             * 같은 사람이 멈추고 되돌리면 suspension은 통제가 아니라 개인의
             * 재량이 된다. 02 §2.8의 "운영자 단독 전환 금지"와 같은 규칙이다.
             */
            if (
              project.suspended_by_subject_id !== null &&
              project.suspended_by_subject_id === session.subjectId
            ) {
              throw forbidden(
                "LIFECYCLE_RESUME_SELF",
                "멈춘 사람은 그 프로젝트를 되돌릴 수 없다",
                { requiredAction: "다른 권한 보유자가 복귀를 판정한다" },
              );
            }
          }

          const [updated] = await tx<ProjectRow[]>`
            UPDATE core.projects
            SET lifecycle_state = ${toState},
                -- 복귀 대상은 suspend 직전 상태다. 나올 때 지운다.
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
