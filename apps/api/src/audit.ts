import type postgres from "postgres";
import type { Session } from "./plugins/session.js";

/**
 * 감사 기록 — 02 §2.7.
 *
 * 모든 mutation은 actor, effective role, tenant/project, command,
 * before/after version, reason, correlation ID, timestamp를 남긴다. 이 테이블은
 * append-only이며 application admin도 삭제할 수 없다(0003_guards.sql).
 */
/**
 * 역할 정책이 아니라 **배정과 서명자 대조**로 허용된 경로 — 04 불변조건 13.
 *
 * attestation 서명 요청·제출은 `ACTION_POLICIES`를 지나지 않는다. 허용 근거가
 * "이 사람이 어떤 역할인가"가 아니라 "복구된 서명자가 이 case에 배정된
 * 검토자인가"이기 때문이다. 그 경로에 임의의 역할 이름을 적으면 감사 기록이
 * 하지 않은 권한 판정을 한 것처럼 보인다.
 */
export const ROLE_ASSIGNMENT_BOUND = "assignment_bound";

/**
 * 세션 없이 배포 환경에서 실행된 경로.
 *
 * 실행한 사람은 배포 환경에 접근할 수 있는 운영자이고 앱은 그를 식별하지 않는다.
 * `actor_subject_id`를 비우면서 역할만 `mpc_operator`로 적으면, 하지 않은 권한
 * 판정을 한 것처럼 보인다 — 없는 신원을 지어내지 않는 것과 같은 이유로 없는
 * 권한 판정도 지어내지 않는다.
 */
export const ROLE_DEPLOY_BOUND = "deploy_bound";

export interface AuditEntry {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly session: Session;
  /**
   * 이 행위를 **허용한** 역할. `assertAuthorized`의 반환값을 그대로 넣는다.
   *
   * 선택 항목이 아니다. 기본값을 두면 호출자가 생각 없이 지나가고, 그 순간
   * 감사 기록은 "누가 무슨 자격으로 했는가"가 아니라 "누가 했는가"만 남긴다.
   */
  readonly effectiveRole: string;
  readonly command: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly beforeVersion?: number;
  readonly afterVersion?: number;
  readonly reason?: string;
  readonly correlationId: string;
  readonly requestIp?: string;
  readonly detail?: Record<string, unknown>;
}

export async function recordAudit(
  tx: postgres.TransactionSql,
  entry: AuditEntry,
): Promise<void> {
  await tx`
    INSERT INTO audit.events (
      tenant_id, project_id, actor_subject_id, actor_wallet, effective_role,
      command, resource_type, resource_id, before_version, after_version,
      reason, correlation_id, request_ip, detail
    ) VALUES (
      ${entry.tenantId},
      ${entry.projectId ?? null},
      ${entry.session.subjectId},
      ${entry.session.walletAddress},
      ${entry.effectiveRole},
      ${entry.command},
      ${entry.resourceType},
      ${entry.resourceId ?? null},
      ${entry.beforeVersion ?? null},
      ${entry.afterVersion ?? null},
      ${entry.reason ?? null},
      ${entry.correlationId},
      ${entry.requestIp ?? null},
      ${tx.json((entry.detail ?? {}) as never)}
    )
  `;
}
