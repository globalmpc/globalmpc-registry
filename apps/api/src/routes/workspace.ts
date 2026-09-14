import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  assertAuthorized,
  holdsActionRole,
  sessionFacts,
  tenantResource,
  visibleProjectScope,
} from "../plugins/authorize.js";
import { requireMutationContext, requireReadContext } from "./shared.js";
import { notFound } from "../errors.js";

/**
 * 워크스페이스 집계 — spec 11 §11.2.
 *
 * 두 화면이 없던 이유는 데이터가 없어서가 아니라 **프로젝트 하나를 열어야만 보이는
 * 구조**였기 때문이다. "이 tenant에서 무엇이 게시됐나"와 "내가 지금 무엇을
 * 해야 하나"는 프로젝트를 하나씩 열어서 답할 질문이 아니다.
 *
 * 여기 있는 것은 전부 읽기다. 상태를 바꾸는 경로는 각 도메인 route가 갖는다 —
 * 집계 화면이 mutation을 갖기 시작하면 권한 판정이 두 곳으로 갈린다.
 */

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/registry-entries", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "registry.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    // 볼 수 있는 프로젝트의 기록만 싣는다. 프로젝트 목록과 같은 이유다.
    const visible = visibleProjectScope(session, "registry.read");

    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => tx<
      {
        entry_id: string;
        registry_type: "project" | "verification" | "asset";
        public_key: string;
        project_id: string | null;
        latest_version: number;
        status: "draft" | "published" | "revoked" | "superseded";
        published_at: Date | null;
        revoked_at: Date | null;
        anchored: boolean;
      }[]
    >`
      SELECT DISTINCT ON (e.id)
             e.id AS entry_id,
             e.registry_type,
             e.public_key,
             p.id AS project_id,
             v.version AS latest_version,
             v.status,
             v.published_at,
             v.revoked_at,
             -- 게시와 anchor는 다른 사건이다. 한 칸에 합치면 "게시됐으니
             -- 체인에 있다"로 읽힌다.
             EXISTS (
               SELECT 1 FROM chain.anchor_batch_leaves l WHERE l.entry_version_id = v.id
             ) AS anchored
      FROM core.registry_entries e
      JOIN core.registry_entry_versions v ON v.entry_id = e.id
      LEFT JOIN core.projects p ON p.id = e.subject_id
      WHERE e.tenant_id = ${tenantId}
        AND ${visible === "all" ? tx`TRUE` : tx`p.id = ANY(${visible as string[]}::uuid[])`}
      ORDER BY e.id, v.version DESC
    `);

    return {
      items: rows.map((row) => ({
        entryId: row.entry_id,
        registryType: row.registry_type,
        publicKey: row.public_key,
        projectId: row.project_id,
        latestVersion: row.latest_version,
        status: row.status,
        publishedAt: row.published_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        anchored: row.anchored,
      })),
      requestId,
      asOf,
    };
  });

  app.get("/api/v1/my-work", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "project.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const { requestId, asOf } = request.context;
    const subjectId = session.subjectId;
    const visible = visibleProjectScope(session, "project.read");

    return withTenant(sql, { tenantId }, async (tx) => {
      /**
       * 나에게 배정된 검토.
       *
       * `revoked_at IS NULL`인 배정만 본다 — 회수된 배정이 목록에 남아 있으면
       * 하지 않아도 되는 일을 계속 보게 된다.
       */
      const assigned = subjectId
        ? await tx<
            {
              case_id: string;
              project_id: string;
              project_name: string;
              state: string;
              assigned_at: Date;
              conflict_status: string;
            }[]
          >`
            SELECT c.id AS case_id, c.project_id, p.name AS project_name,
                   c.state::text AS state, a.assigned_at, a.conflict_status
            FROM core.assignments a
            JOIN core.verification_cases c ON c.id = a.case_id
            JOIN core.projects p ON p.id = c.project_id
            WHERE a.tenant_id = ${tenantId}
              AND a.subject_id = ${subjectId}
              AND a.revoked_at IS NULL
              -- 끝난 case는 할 일이 아니다. registered·declined·cancelled·
              -- superseded·revoked는 더 이상 검토자가 움직일 것이 없다.
              AND c.state IN ('draft', 'assigned', 'in_review', 'changes_requested', 'signed')
            ORDER BY a.assigned_at
          `
        : [];

      /** 내가 시작했고 다른 사람의 결정을 기다리는 것. 내가 할 일은 없다. */
      const waiting = subjectId
        ? await tx<{ id: string; role: string; subject_name: string; requested_at: Date }[]>`
            SELECT g.id, g.role, s.display_name AS subject_name, g.requested_at
            FROM core.role_grant_requests g
            JOIN core.subjects s ON s.id = g.subject_id
            WHERE g.tenant_id = ${tenantId}
              AND g.state = 'pending'
              AND g.requested_by_subject_id = ${subjectId}
            ORDER BY g.requested_at
          `
        : [];

      /**
       * 아무에게도 배정되지 않았지만 열려 있는 것.
       *
       * 이것을 따로 내는 이유: 배정된 일만 보이면 **아무도 맡지 않은 일**이
       * 영원히 보이지 않는다. 방치가 조용히 일어나는 자리다.
       */
      const staleSignals = await tx<
        { id: string; project_id: string | null; reason: string; detected_at: Date }[]
      >`
        SELECT id, project_id, reason, detected_at
        FROM core.evidence_stale_signals
        WHERE tenant_id = ${tenantId} AND resolution = 'open'
          AND ${visible === "all" ? tx`TRUE` : tx`project_id = ANY(${visible as string[]}::uuid[])`}
        ORDER BY detected_at
        LIMIT 50
      `;

      // 내가 제안하지 않은 pending 제안 = 내가 결정할 수 있는 것.
      // 결정 역할이 없으면 결정할 수 있는 것이 아니다 — 누가 어떤 역할을 받는지만 샌다.
      const decisions = !holdsActionRole(session, "admin.role.approve") ? [] : await tx<
        { id: string; role: string; subject_name: string; requested_at: Date }[]
      >`
        SELECT g.id, g.role, s.display_name AS subject_name, g.requested_at
        FROM core.role_grant_requests g
        JOIN core.subjects s ON s.id = g.subject_id
        WHERE g.tenant_id = ${tenantId}
          AND g.state = 'pending'
          AND (${subjectId}::uuid IS NULL OR g.requested_by_subject_id <> ${subjectId})
        ORDER BY g.requested_at
      `;

      return {
        assignedToMe: assigned.map((row) => ({
          caseId: row.case_id,
          projectId: row.project_id,
          projectName: row.project_name,
          state: row.state,
          assignedAt: row.assigned_at.toISOString(),
          conflictStatus: row.conflict_status,
        })),
        waitingOnOthers: waiting.map((row) => ({
          kind: "role_grant" as const,
          id: row.id,
          summary: `${row.subject_name}에게 ${row.role}을 주자는 제안 — 다른 사람의 결정을 기다린다`,
          since: row.requested_at.toISOString(),
        })),
        unassigned: [
          ...staleSignals.map((row) => ({
            kind: "stale_signal" as const,
            id: row.id,
            projectId: row.project_id,
            summary: row.reason,
            since: row.detected_at.toISOString(),
          })),
          ...decisions.map((row) => ({
            kind: "role_grant_decision" as const,
            id: row.id,
            projectId: null,
            summary: `${row.subject_name}에게 ${row.role}을 주자는 제안 — 결정이 필요하다`,
            since: row.requested_at.toISOString(),
          })),
        ],
        requestId,
        asOf,
      };
    });
  });

  /**
   * 알림.
   *
   * 나에게 온 것과 **내가 가진 역할에게 온 것**을 함께 낸다. 후자가 없으면
   * stale 신호나 철회처럼 아무에게도 배정되지 않은 사건이 아무에게도 도달하지
   * 않는다.
   *
   * 발신 수단(메일·webhook)은 정해진 바 없다. 앱 안에서 읽는 경로를
   * 먼저 연다 — 그것이 없으면 어느 수단을 고르든 보낼 내용이 없다.
   */
  app.get("/api/v1/notifications", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "project.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const { requestId, asOf } = request.context;
    const subjectId = session.subjectId;
    const roles = session.roleBindings.map((binding) => binding.role);
    // 역할에게 온 알림도 볼 수 있는 프로젝트의 것만. 역할 이름만 맞으면
    // 다른 회사 프로젝트의 stale 사유와 링크가 그대로 실린다.
    const visible = visibleProjectScope(session, "project.read");

    const rows = await withTenant(sql, { tenantId }, (tx) => tx<
      {
        id: string;
        kind: "review_assigned" | "readiness_gap" | "evidence_stale" | "registry_revoked";
        subject_id: string | null;
        audience_role: string | null;
        project_id: string | null;
        summary: string;
        link: string;
        occurred_at: Date;
        read: boolean;
      }[]
    >`
      SELECT n.id, n.kind, n.subject_id, n.audience_role, n.project_id,
             n.summary, n.link, n.occurred_at,
             (r.notification_id IS NOT NULL) AS read
      FROM core.notifications n
      LEFT JOIN core.notification_reads r
        ON r.notification_id = n.id AND r.subject_id = ${subjectId}
      WHERE n.tenant_id = ${tenantId}
        AND (
          n.subject_id = ${subjectId}
          OR (
            n.audience_role = ANY(${roles})
            AND (
              n.project_id IS NULL
              OR ${visible === "all" ? tx`TRUE` : tx`n.project_id = ANY(${visible as string[]}::uuid[])`}
            )
          )
        )
      ORDER BY n.occurred_at DESC
      LIMIT 100
    `);

    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        audience: row.subject_id === null ? ("role" as const) : ("you" as const),
        audienceRole: row.audience_role,
        projectId: row.project_id,
        summary: row.summary,
        link: row.link,
        occurredAt: row.occurred_at.toISOString(),
        read: row.read,
      })),
      requestId,
      asOf,
    };
  });

  app.post<{ Params: { notificationId: string } }>(
    "/api/v1/notifications/:notificationId/read",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);
      assertAuthorized(
        session,
        "project.read",
        tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
        sessionFacts(session),
      );

      const { requestId, asOf } = request.context;
      const subjectId = session.subjectId;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [found] = await tx<
          {
            id: string;
            kind: "review_assigned" | "readiness_gap" | "evidence_stale" | "registry_revoked";
            subject_id: string | null;
            audience_role: string | null;
            project_id: string | null;
            summary: string;
            link: string;
            occurred_at: Date;
          }[]
        >`
          SELECT id, kind, subject_id, audience_role, project_id, summary, link, occurred_at
          FROM core.notifications
          WHERE tenant_id = ${tenantId} AND id = ${request.params.notificationId}
        `;
        if (!found) throw notFound("알림을 찾을 수 없다");

        /**
         * 읽음은 **나에 대해서만** 기록된다.
         *
         * 역할로 간 알림을 내가 읽었다고 남에게서 지우면, 내가 처리하지 않았을 때
         * 아무도 다시 보지 않는다.
         */
        await tx`
          INSERT INTO core.notification_reads (notification_id, subject_id, tenant_id)
          VALUES (${found.id}, ${subjectId}, ${tenantId})
          ON CONFLICT DO NOTHING
        `;

        return {
          id: found.id,
          kind: found.kind,
          audience: found.subject_id === null ? ("role" as const) : ("you" as const),
          audienceRole: found.audience_role,
          projectId: found.project_id,
          summary: found.summary,
          link: found.link,
          occurredAt: found.occurred_at.toISOString(),
          read: true,
          requestId,
          asOf,
        };
      });
    },
  );
}
