import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requireMutationContext, requireReadContext } from "./shared.js";

/**
 * 근거 신호 — spec 10 §175, AC-21.
 *
 * 전파의 마지막 구간이다. `attestation → assessment → Registry version`은 앞
 * 구간과 같은 방법을 쓸 수 없다:
 *
 * - `compliance_assessments`는 append-only다.
 * - `registry_entry_versions`는 게시 뒤 내용이 불변이다.
 *
 * 그래서 대상을 바꾸는 대신 **신호를 남긴다.** 신호가 열려 있다는 것은 재검토가
 * 필요하다는 뜻이지 그 기록이 틀렸다는 뜻이 아니다 — 그 구분이 없으면 출처
 * 장애가 곧 기록 부정이 된다.
 *
 * **자동으로 revoke하지 않는다.** 공개된 Registry 기록을 내리는 것은 세상이 보는
 * 것을 바꾸는 행위이고, 연동 하나가 끊겼다고 공개 기록이 사라지면 출처 장애가
 * 곧 기록 삭제가 된다.
 */

const resolveSchema = z.object({
  resolution: z.enum(["superseded", "revoked", "dismissed"]),
  note: z.string().min(1),
});

interface SignalRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly origin_attestation_id: string | null;
  readonly reason: string;
  readonly detected_at: Date;
  readonly resolution: string;
  readonly resolved_at: Date | null;
  readonly resolution_note: string | null;
}

/**
 * 이 신호로 할 수 있는 것.
 *
 * 화면이 상태 문자열을 보고 추측하면 화면마다 다르게 읽는다. 특히 "공개 기록을
 * 내린다"는 선택지가 조용히 노출되면 안 된다.
 */
function nextActions(row: SignalRow): string[] {
  if (row.resolution !== "open") return [];

  if (row.target_type === "registry_entry_version") {
    return [
      "새 version으로 정정한다 (supersede)",
      "공개 기록을 내린다 (revoke) — 세상이 보는 것이 바뀐다",
      "영향 없음으로 판정한다 (dismiss) — 이유가 기록된다",
    ];
  }

  return ["재평가를 실행한다", "영향 없음으로 판정한다 (dismiss) — 이유가 기록된다"];
}

function toView(row: SignalRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    targetType: row.target_type,
    targetId: row.target_id,
    originAttestationId: row.origin_attestation_id,
    reason: row.reason,
    detectedAt: row.detected_at.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolutionNote: row.resolution_note,
    nextActions: nextActions(row),
  };
}

export async function registerStaleSignalRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/stale-signals",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );
      const { requestId, asOf } = request.context;

      const rows = await withTenant(
        sql,
        { tenantId },
        (tx) =>
          tx<SignalRow[]>`
          SELECT id, project_id, target_type::text AS target_type, target_id,
                 origin_attestation_id, reason, detected_at,
                 resolution::text AS resolution, resolved_at, resolution_note
          FROM core.evidence_stale_signals
          WHERE project_id = ${request.params.projectId}
          -- 열린 것을 먼저 보여준다. 처리된 것도 남긴다 — 무엇을 어떻게
          -- 판단했는지가 다음 판단의 근거다.
          ORDER BY (resolution = 'open') DESC, detected_at DESC
        `,
      );

      return {
        items: rows.map(toView),
        openCount: rows.filter((row) => row.resolution === "open").length,
        requestId,
        asOf,
      };
    },
  );

  app.post<{ Params: { signalId: string } }>(
    "/api/v1/stale-signals/:signalId/resolve",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);

      const parsed = resolveSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      /**
       * `registry.revoke` 권한을 요구한다.
       *
       * 신호를 닫는 것은 "이 공개 기록을 어떻게 할지 정했다"는 선언이다.
       * `dismissed`도 마찬가지다 — 아무것도 하지 않기로 한 판단이며, 그것도
       * 공개 기록의 운명을 정한다.
       */
      const effectiveRole = assertAuthorized(
        session,
        "registry.revoke",
        tenantResource(tenantId, { sensitivity: "public" }),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [current] = await tx<SignalRow[]>`
          SELECT id, project_id, target_type::text AS target_type, target_id,
                 origin_attestation_id, reason, detected_at,
                 resolution::text AS resolution, resolved_at, resolution_note
          FROM core.evidence_stale_signals
          WHERE id = ${request.params.signalId}
          FOR UPDATE
        `;
        if (!current) throw notFound("신호를 찾을 수 없다");

        if (current.resolution !== "open") {
          throw conflict("SIGNAL_ALREADY_RESOLVED", `이미 ${current.resolution}로 닫혔다`);
        }

        const [row] = await tx<SignalRow[]>`
          UPDATE core.evidence_stale_signals SET
            resolution = ${parsed.data.resolution},
            resolved_at = now(),
            resolved_by = ${session.subjectId},
            resolution_note = ${parsed.data.note}
          WHERE id = ${current.id}
          RETURNING id, project_id, target_type::text AS target_type, target_id,
                    origin_attestation_id, reason, detected_at,
                    resolution::text AS resolution, resolved_at, resolution_note
        `;

        /**
         * **신호를 닫는 것이 대상을 바꾸지 않는다.**
         *
         * `revoked`로 닫아도 Registry version은 그대로다. 실제로 내리려면
         * `registry-entries/{id}/revoke`를 따로 호출한다 — 한 번의 요청으로 두
         * 가지 일이 일어나면 무엇이 실행됐는지 나중에 알 수 없다.
         */
        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          ...(current.project_id ? { projectId: current.project_id } : {}),
          session,
          command: "stale_signal.resolved",
          resourceType: "evidence_stale_signal",
          resourceId: current.id,
          correlationId,
          requestIp: request.ip,
          reason: parsed.data.note,
          detail: {
            resolution: parsed.data.resolution,
            targetType: current.target_type,
            targetId: current.target_id,
          },
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "stale_signal.resolved",
          aggregateId: current.id,
          aggregateVersion: 1,
          ...(current.project_id ? { projectId: current.project_id } : {}),
          correlationId,
          payload: {
            resolution: parsed.data.resolution,
            targetType: current.target_type,
          },
        });

        return {
          ...toView(row!),
          // 닫았다고 대상이 바뀐 것은 아니다. 화면이 오해하지 않게 말한다.
          targetUnchanged: true,
          requestId,
          asOf,
        };
      });
    },
  );
}
