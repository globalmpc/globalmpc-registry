import type postgres from "postgres";
import type { Session } from "./plugins/session.js";

/**
 * Audit record — 02 §2.7.
 *
 * Every mutation records actor, effective role, tenant/project, command,
 * before/after version, reason, correlation ID, and timestamp. This table is
 * append-only; not even the application admin can delete from it (0003_guards.sql).
 */
/**
 * Path allowed by **assignment and signer matching**, not role policy — 04 invariant 13.
 *
 * Attestation signature submissions do not go through `ACTION_POLICIES`. The basis for allowing
 * them is not "what role is this person" but "is the recovered signer the reviewer assigned to
 * this case". Writing an arbitrary role name on that path would make the audit record look like
 * an authorization decision that was never made. (Signature requests do go through the policy
 * since W-085 and record the role that passed.)
 */
export const ROLE_ASSIGNMENT_BOUND = "assignment_bound";

/**
 * Path run in the deployment environment without a session.
 *
 * The runner is an operator with deployment environment access; the app does not identify them.
 * Leaving `actor_subject_id` empty while writing only the role as `mpc_operator` would look like
 * an authorization decision that was never made — for the same reason no identity is invented,
 * no authorization decision is invented either.
 */
export const ROLE_DEPLOY_BOUND = "deploy_bound";

export interface AuditEntry {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly session: Session;
  /**
   * The role that **allowed** this action. Pass the return value of `assertAuthorized` as is.
   *
   * Not optional. A default lets callers pass through without thinking, and at that moment the
   * audit record keeps only "who did it", not "who did it in what capacity".
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
