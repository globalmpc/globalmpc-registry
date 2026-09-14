import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  adapterStateReason,
  checkAdapterAvailable,
  checkOfferingGate,
  connectionStateToAdapterState,
  OFFERING_ABSENCE_COPY,
  OFFERING_NOT_MEANING,
} from "@mpc/domain";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { requireReadContext } from "./shared.js";

/**
 * Authority Registry — spec 05 §5.11, OD-42·OD-43.
 *
 * 이 라우트가 지키는 것:
 *
 * - **`doesNotProve`를 항상 함께 반환한다.** 확인해 주는 것만 보여주면 읽는
 *   쪽이 전체 확인으로 오해한다. DB CHECK가 빈 값을 막지만 응답에서 빠지면
 *   같은 오해가 생긴다.
 * - **연동되지 않은 기관도 목록에 남는다.** 빼면 "왜 이 기관은 없나"를 알 수
 *   없고, active로 두면 있지도 않은 연동을 약속한다(R5 gate: 미확인 integration
 *   과장 0).
 * - **호출 가능 여부와 다음 행동을 서버가 판정한다.** 화면이 상태 문자열을 보고
 *   추측하면 화면마다 다르게 읽는다.
 */

interface AuthorityRow {
  readonly id: string;
  readonly name: string;
  readonly jurisdiction: string;
  readonly proves: string[];
  readonly does_not_prove: string[];
  readonly recognized_scope: string[];
  readonly verification_method: string;
  readonly state: string;
  readonly valid_from: Date;
  readonly valid_until: Date | null;
  readonly connection_key: string | null;
  readonly connection_state: string | null;
}

function toView(row: AuthorityRow) {
  const adapterState = connectionStateToAdapterState(row.connection_state);
  const reason = adapterStateReason(adapterState, row.connection_state);

  // `none`은 adapter 자체가 없으므로 도메인 판정 대상이 아니다.
  const availability =
    adapterState === "none"
      ? { callable: false as const, reason: "NO_CONNECTION", nextAction: "연동을 먼저 등록한다" }
      : checkAdapterAvailable({
          connectionKey: row.connection_key ?? "",
          authorityName: row.name,
          jurisdiction: row.jurisdiction,
          state: adapterState,
          proves: row.proves,
          doesNotProve: row.does_not_prove,
          stateReason: reason,
        });

  return {
    id: row.id,
    name: row.name,
    jurisdiction: row.jurisdiction,
    proves: row.proves,
    // 05 §5.11: 한계 없는 authority는 존재하지 않는다.
    doesNotProve: row.does_not_prove,
    recognizedScope: row.recognized_scope,
    verificationMethod: row.verification_method,
    state: row.state,
    validFrom: row.valid_from.toISOString().slice(0, 10),
    validUntil: row.valid_until?.toISOString().slice(0, 10) ?? null,
    adapterState,
    adapterStateReason: reason || null,
    connectionKey: row.connection_key,
    callable: availability.callable,
    nextAction: availability.callable ? null : availability.nextAction,
  };
}

const PROFILE_LIMITATIONS = [
  "연동 상태는 접근 권한 여부이며 그 출처가 사실을 보증한다는 뜻이 아니다",
  "manual은 사람이 조회한다는 뜻이며 연동 장애가 아니다",
  "pending_access인 출처는 호출되지 않는다 — 이 목록은 가능한 연동을 약속하지 않는다",
] as const;

export async function registerAuthorityRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/authorities", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    const { requestId, asOf } = request.context;

    assertAuthorized(
      session,
      "authority.read",
      tenantResource(tenantId),
      sessionFacts(session),
    );

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<AuthorityRow[]>`
        SELECT a.id, a.name, a.jurisdiction, a.proves, a.does_not_prove,
               a.recognized_scope, a.verification_method, a.state,
               a.valid_from, a.valid_until,
               c.connection_key, c.state::text AS connection_state
        FROM core.authorities a
        LEFT JOIN core.source_connections c ON c.authority_id = a.id
        ORDER BY a.jurisdiction, a.name
      `,
    );

    return { items: rows.map(toView), requestId, asOf };
  });

  /**
   * 자산·청약 활성화 조건 — OD-07.
   *
   * **거래 route가 아니다.** 이 경로는 "왜 아직 없는가"에 답한다. 조건 충족
   * 여부는 `project_facts`에 기록된 것을 읽는다 — 별도 승인 테이블을 만들면
   * 그 테이블을 채우는 것이 곧 활성화처럼 보인다.
   *
   * 지금은 어떤 프로젝트도 조건을 채우지 못한다. 그것이 정상이며, 채워지더라도
   * 코드에 거래 경로는 여전히 없다.
   */
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/offering-gate",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      assertAuthorized(
        session,
        "project.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const facts = await withTenant(sql, { tenantId }, (tx) =>
        tx<{ fact_key: string; status: string; evidence_ref: string | null }[]>`
          SELECT fact_key, status, evidence_ref
          FROM core.project_facts
          WHERE project_id = ${request.params.projectId}
        `,
      );

      const statuses = facts.map((fact) => ({
        key: fact.fact_key as never,
        // `confirmed`만 충족이다. `pending`은 확인 중이지 확인된 것이 아니다.
        satisfied: fact.status === "confirmed",
        evidenceRef: fact.evidence_ref,
      }));

      const decision = checkOfferingGate(statuses);

      return {
        projectId: request.params.projectId,
        activatable: decision.activatable,
        missing: decision.activatable ? [] : decision.missing,
        unsupported: decision.activatable ? [] : decision.unsupported,
        // 기능이 없다는 사실을 응답이 직접 말한다. 화면이 잊어도 API가 말한다.
        absenceNotice: OFFERING_ABSENCE_COPY.ko,
        notMeaning: OFFERING_NOT_MEANING.ko,
        requestId,
        asOf,
      };
    },
  );

  /**
   * 관할별 연동 현황 — OD-43.
   *
   * 활성·수동·대기를 나눠 센다. 합계만 보여주면 "10개 기관 연동"이 실제로는
   * 1개만 호출 가능한 상태를 감춘다.
   */
  app.get<{ Params: { jurisdiction: string } }>(
    "/api/v1/jurisdictions/:jurisdiction/profile",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      assertAuthorized(
        session,
        "authority.read",
        tenantResource(tenantId),
        sessionFacts(session),
      );

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<AuthorityRow[]>`
          SELECT a.id, a.name, a.jurisdiction, a.proves, a.does_not_prove,
                 a.recognized_scope, a.verification_method, a.state,
                 a.valid_from, a.valid_until,
                 c.connection_key, c.state::text AS connection_state
          FROM core.authorities a
          LEFT JOIN core.source_connections c ON c.authority_id = a.id
          WHERE a.jurisdiction = ${request.params.jurisdiction.toUpperCase()}
          ORDER BY a.name
        `,
      );

      const authorities = rows.map(toView);

      return {
        jurisdiction: request.params.jurisdiction.toUpperCase(),
        authorities,
        activeCount: authorities.filter((item) => item.adapterState === "active").length,
        manualCount: authorities.filter((item) => item.adapterState === "manual").length,
        pendingCount: authorities.filter((item) =>
          ["pending_access", "blocked", "none"].includes(item.adapterState),
        ).length,
        limitations: [...PROFILE_LIMITATIONS],
        requestId,
        asOf,
      };
    },
  );
}
