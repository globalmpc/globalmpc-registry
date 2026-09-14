import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { myActivityQuery } from "@mpc/api-contract";
import { badRequest } from "../errors.js";
import {
  assertAuthorized,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { requireReadContext } from "./shared.js";

/**
 * 관측 route — spec 02 §2.6, 07 §7.5.
 *
 * `audit.events`가 append-only이고 superuser도 수정할 수 없다는 보장은, 읽는
 * 경로가 없으면 운영에 쓰이지 못한다. DB에 직접 붙어야만 볼 수 있는 감사 기록은
 * 감사의 신뢰를 오히려 떨어뜨린다.
 *
 * 두 가지를 지킨다.
 *
 * - **`detail`을 그대로 내보내지 않는다.** 이벤트 payload에 PII를 넣지 않기로
 *   했지만, 약속이 깨졌을 때 이 화면이 최초 유출 경로가 된다.
 * - **읽기에도 권한이 있다.** `audit.read`는 auditor·security_operator·
 *   mpc_operator만 갖는다. 누가 무엇을 했는지는 아무나 볼 것이 아니다.
 */

const auditQuerySchema = z.object({
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  command: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerObservabilityRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * 내 활동.
   *
   * 이 지갑에 묶인 주체가 한 mutation만 낸다. **역할 검사가 없는 것이 의도다** —
   * 남의 기록이 아니라 자기 기록이다. tenant 전체 감사 기록(`audit.read`)과는
   * 질문이 다르다: 저쪽은 "여기서 무슨 일이 있었나", 이쪽은 "내가 무엇을 했나".
   */
  app.get("/api/v1/me/activity", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    const parsed = myActivityQuery.safeParse(request.query);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "조회 조건이 올바르지 않다", {
        issues: parsed.error.issues,
      });
    }

    const { limit, cursor } = parsed.data;
    const { requestId, asOf } = request.context;
    // 주체가 없는 지갑은 한 일이 기록될 수 없다. 오류가 아니라 빈 목록이다.
    if (session.subjectId === null) return { items: [], nextCursor: null, requestId, asOf };
    const subjectId = session.subjectId;

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<
        {
          id: string;
          occurred_at: Date;
          command: string;
          resource_type: string;
          resource_id: string | null;
          project_id: string | null;
          effective_role: string | null;
          reason: string | null;
          signature_or_tx: string | null;
        }[]
      >`
        SELECT id::text, occurred_at, command, resource_type, resource_id, project_id,
               effective_role, reason, signature_or_tx
        FROM audit.events
        WHERE tenant_id = ${tenantId}
          AND actor_subject_id = ${subjectId}
          AND (${cursor ?? null}::bigint IS NULL OR id < ${cursor ?? null}::bigint)
        ORDER BY id DESC
        LIMIT ${limit + 1}
      `,
    );

    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        command: row.command,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        projectId: row.project_id,
        effectiveRole: row.effective_role,
        reason: row.reason,
        signatureOrTx: row.signature_or_tx,
      })),
      // id는 BIGSERIAL이라 단조 증가한다. 그 자체가 keyset이다.
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      requestId,
      asOf,
    };
  });

  app.get("/api/v1/audit-events", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    assertAuthorized(session, "audit.read", tenantResource(tenantId), sessionFacts(session));

    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "조회 조건이 올바르지 않다", {
        issues: parsed.error.issues,
      });
    }

    const { resourceType, resourceId, projectId, command, limit } = parsed.data;
    const { requestId, asOf } = request.context;

    const rows = await withTenant(
      sql,
      { tenantId },
      (tx) =>
        tx<
          {
            id: string;
            occurred_at: Date;
            command: string;
            resource_type: string;
            resource_id: string | null;
            actor_wallet: string | null;
            effective_role: string | null;
            before_version: number | null;
            after_version: number | null;
            reason: string | null;
            correlation_id: string;
            project_id: string | null;
          }[]
        >`
        SELECT id::text, occurred_at, command, resource_type, resource_id,
               actor_wallet, effective_role, before_version, after_version,
               reason, correlation_id, project_id
        FROM audit.events
        WHERE tenant_id = ${tenantId}
          AND (${resourceType ?? null}::text IS NULL OR resource_type = ${resourceType ?? null})
          AND (${resourceId ?? null}::uuid IS NULL OR resource_id = ${resourceId ?? null})
          AND (${projectId ?? null}::uuid IS NULL OR project_id = ${projectId ?? null})
          AND (${command ?? null}::text IS NULL OR command = ${command ?? null})
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${limit}
      `,
    );

    return {
      // detail은 내보내지 않는다. 무엇이 일어났는지는 command와 resource로 충분하다.
      items: rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        command: row.command,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        actorWallet: row.actor_wallet,
        effectiveRole: row.effective_role,
        beforeVersion: row.before_version,
        afterVersion: row.after_version,
        reason: row.reason,
        correlationId: row.correlation_id,
        projectId: row.project_id,
      })),
      requestId,
      asOf,
    };
  });

  /**
   * 이벤트 발행 backlog.
   *
   * outbox는 at-least-once다. 쌓인다는 것은 이벤트가 사라졌다는 뜻이 아니라
   * **늦어진다**는 뜻이다 — 그 구분이 대응을 정한다. 사라졌다고 오인하면
   * 수동으로 재생성하게 되고 그것이 진짜 중복을 만든다.
   */
  app.get("/api/v1/outbox-backlog", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    assertAuthorized(session, "audit.read", tenantResource(tenantId), sessionFacts(session));

    const { requestId, asOf } = request.context;

    return withTenant(sql, { tenantId }, async (tx) => {
      const [summary] = await tx<
        { pending: string; oldest: Date | null; published_last_hour: string }[]
      >`
        SELECT
          count(*) FILTER (WHERE published_at IS NULL)::text AS pending,
          min(occurred_at) FILTER (WHERE published_at IS NULL) AS oldest,
          count(*) FILTER (WHERE published_at >= now() - interval '1 hour')::text
            AS published_last_hour
        FROM core.outbox
      `;

      const byType = await tx<{ event_type: string; pending: string }[]>`
        SELECT event_type, count(*)::text AS pending
        FROM core.outbox WHERE published_at IS NULL
        GROUP BY event_type ORDER BY count(*) DESC
      `;

      const oldest = summary?.oldest ?? null;

      return {
        pending: Number(summary?.pending ?? "0"),
        oldestPendingAt: oldest?.toISOString() ?? null,
        // 건수보다 지연 시간이 중요하다. 1000건이 1초 늦는 것과 1건이 한 시간
        // 늦는 것은 다른 문제다.
        oldestPendingAgeSeconds: oldest ? Math.floor((Date.now() - oldest.getTime()) / 1000) : null,
        publishedLastHour: Number(summary?.published_last_hour ?? "0"),
        byEventType: byType.map((row) => ({
          eventType: row.event_type,
          pending: Number(row.pending),
        })),
        requestId,
        asOf,
      };
    });
  });
}
