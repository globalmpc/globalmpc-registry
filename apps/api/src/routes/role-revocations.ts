import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  ACTION_POLICIES,
  createRoleRevocationRequest,
  decideRoleRevocationRequest,
  ROLE_MINIMUM_ASSURANCE,
} from "@mpc/api-contract";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Role revocation — the mirror of role grants in `admin.ts` (02 §2.8).
 *
 * **This did not exist before.** Disabling every wallet of a person was the only way to take a
 * role back. That cut off everything else the person legitimately held, and it left the binding
 * in force for the day a new key is bound.
 *
 * **Two-person rule, same as grants.** Revoking changes the same thing a grant does — who holds
 * which role. If one person could revoke alone, a single operator could strip every other
 * operator and be left alone with the role that grants roles. The DB's
 * `role_revocation_two_person` blocks the same thing, so adding a route does not leak the rule.
 *
 * **The grant actions are reused** (`admin.role.propose`, `admin.role.approve`). The question
 * each answers — "may this person start / decide a change to who holds which role" — is the
 * same for giving and for taking away, and they allow the same roles. A separate action with the
 * same role list would add no restriction, only a second place for the two to drift apart.
 *
 * **The last approver cannot be revoked.** A revocation that would leave no one able to approve
 * role changes is refused, at proposal and again at decision. Otherwise the tenant can only be
 * recovered with the `bootstrap` CLI on the server.
 */

interface RevocationRow {
  id: string;
  role_binding_id: string;
  subject_id: string;
  subject_name: string;
  role: string;
  project_id: string | null;
  reason_code: "offboarding" | "duty_change" | "security_concern" | "granted_in_error";
  reason: string;
  requested_by_subject_id: string;
  requested_at: Date;
  state: "pending" | "approved" | "rejected" | "withdrawn";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  version: number;
}

interface BindingRow {
  id: string;
  subject_id: string;
  role: string;
  revoked_at: Date | null;
}

type Tx = postgres.TransactionSql;

/** Roles that can approve role changes — the same source the grant flow uses. */
const APPROVER_ROLES: readonly string[] =
  ACTION_POLICIES["admin.role.approve"]?.allowedRoles ?? [];

/** The assurance each approving role needs before it is exercised — same fallback as authorize. */
const APPROVER_MINIMUM_ASSURANCE: readonly string[] = APPROVER_ROLES.map(
  (role) => ROLE_MINIMUM_ASSURANCE[role] ?? "high_assurance",
);

function toRevocation(row: RevocationRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    roleBindingId: row.role_binding_id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    role: row.role,
    projectId: row.project_id,
    reasonCode: row.reason_code,
    reason: row.reason,
    requestedBySubjectId: row.requested_by_subject_id,
    requestedAt: row.requested_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    version: row.version,
    requestId,
    asOf,
  };
}

function invalidRequest(issues: unknown) {
  return badRequest("REQUEST_INVALID", "Request format is invalid", { issues });
}

function activeTenant(tenantId: string) {
  return tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] });
}

function readRevocations(tx: Tx, tenantId: string, revocationId?: string) {
  return tx<RevocationRow[]>`
    SELECT r.id, r.role_binding_id, b.subject_id, s.display_name AS subject_name, b.role,
           b.project_id, r.reason_code, r.reason, r.requested_by_subject_id, r.requested_at,
           r.state, r.decided_by_subject_id, r.decided_at, r.decision_reason, r.version
    FROM core.role_revocation_requests r
    JOIN core.role_bindings b ON b.id = r.role_binding_id
    JOIN core.subjects s ON s.id = b.subject_id
    WHERE r.tenant_id = ${tenantId}
      AND (${revocationId ?? null}::uuid IS NULL OR r.id = ${revocationId ?? null})
    ORDER BY r.requested_at DESC
  `;
}

/**
 * One revocation at a time per tenant.
 *
 * The last-approver check counts holders and then acts on that count. Two revocations decided
 * at once would each see the other's target still active, and both would pass. Taken first in
 * both routes, so the order of locks is always the same and the routes cannot deadlock.
 */
async function serializeRoleChanges(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`role_revocation:${tenantId}`}, 0))`;
}

async function lockBinding(tx: Tx, tenantId: string, bindingId: string): Promise<BindingRow> {
  const [binding] = await tx<BindingRow[]>`
    SELECT id, subject_id, role, revoked_at FROM core.role_bindings
    WHERE tenant_id = ${tenantId} AND id = ${bindingId}
    FOR UPDATE
  `;
  if (!binding) throw notFound("Role binding not found");
  if (binding.revoked_at !== null) {
    throw unprocessable("ROLE_BINDING_ALREADY_REVOKED", "This role binding is already revoked", {
      revokedAt: binding.revoked_at.toISOString(),
    });
  }
  return binding;
}

/**
 * Refuses a revocation that would leave no one able to approve role changes.
 *
 * Counts **people**, not bindings — someone holding two approving roles is one approver. Only
 * people with a usable wallet count: a holder whose every wallet is disabled cannot sign in, so
 * cannot approve anything, and wallets of approving holders are not rebound from the UI. The
 * wallet must also meet the role's assurance: a weaker wallet signs in, but every approval it
 * attempts is refused with ASSURANCE_LEVEL_INSUFFICIENT.
 */
async function assertApproverRemains(tx: Tx, tenantId: string, binding: BindingRow): Promise<void> {
  if (!APPROVER_ROLES.includes(binding.role)) return;

  const [row] = await tx<{ holders: number }[]>`
    SELECT count(DISTINCT b.subject_id)::int AS holders
    FROM core.role_bindings b
    WHERE b.tenant_id = ${tenantId}
      AND b.id <> ${binding.id}
      AND b.revoked_at IS NULL
      AND b.role = ANY(${[...APPROVER_ROLES]})
      AND EXISTS (
        SELECT 1
        FROM core.wallet_identities w
        JOIN unnest(
          ${[...APPROVER_ROLES]}::text[],
          ${[...APPROVER_MINIMUM_ASSURANCE]}::core.assurance_level[]
        ) AS need(role, minimum) ON need.role = b.role
        WHERE w.tenant_id = b.tenant_id AND w.subject_id = b.subject_id AND w.disabled_at IS NULL
          AND w.assurance_level >= need.minimum
      )
  `;

  if ((row?.holders ?? 0) === 0) {
    throw unprocessable(
      "ROLE_REVOCATION_LAST_APPROVER",
      "This revocation would leave no one able to approve role changes",
      { hint: "Grant an approving role to another person first. Otherwise only the bootstrap CLI can recover this tenant" },
    );
  }
}

export async function registerRoleRevocationRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/admin/role-revocations", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(session, "admin.read", activeTenant(tenantId), sessionFacts(session));

    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => readRevocations(tx, tenantId));
    return { items: rows.map((row) => toRevocation(row, requestId, asOf)), requestId, asOf };
  });

  app.post("/api/v1/admin/role-revocations", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.role.propose",
      activeTenant(tenantId),
      sessionFacts(session),
    );

    const parsed = createRoleRevocationRequest.safeParse(request.body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const { requestId, asOf, correlationId } = request.context;
    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
        await serializeRoleChanges(tx, tenantId);
        const binding = await lockBinding(tx, tenantId, parsed.data.roleBindingId);
        // Checked at proposal too: a proposal no one could ever approve only waits forever.
        await assertApproverRemains(tx, tenantId, binding);

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.role_revocation_requests (
              id, tenant_id, role_binding_id, reason_code, reason, requested_by_subject_id
            ) VALUES (
              ${id}, ${tenantId}, ${binding.id}, ${parsed.data.reasonCode},
              ${parsed.data.reason}, ${session.subjectId}
            )
          `;
        } catch (caught) {
          // Two open proposals for one binding blur which one the approver approved. A partial
          // UNIQUE in the DB blocks it.
          if (caught instanceof Error && caught.message.includes("role_revocation_requests_one_pending")) {
            throw conflict(
              "ROLE_REVOCATION_ALREADY_PENDING",
              "A pending revocation proposal already exists for this role binding",
            );
          }
          throw caught;
        }

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "admin.role_revocation.proposed",
          resourceType: "role_revocation_request",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.ip,
          detail: { roleBindingId: binding.id, role: binding.role },
        });

        const [row] = await readRevocations(tx, tenantId, id);
        return toRevocation(row!, requestId, asOf);
      }),
    );
  });

  app.post<{ Params: { revocationId: string } }>(
    "/api/v1/admin/role-revocations/:revocationId/decision",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.role.approve",
        tenantResource(tenantId, { state: "pending", statesAllowingAction: ["pending"] }),
        sessionFacts(session),
      );

      // Checks If-Match before the body — a missing header must not hide behind a body error.
      const expected = requireIfMatch(request);

      const parsed = decideRoleRevocationRequest.safeParse(request.body);
      if (!parsed.success) throw invalidRequest(parsed.error.issues);

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
          await serializeRoleChanges(tx, tenantId);
          const [current] = await tx<
            Pick<RevocationRow, "id" | "role_binding_id" | "requested_by_subject_id" | "state" | "version">[]
          >`
            SELECT id, role_binding_id, requested_by_subject_id, state, version
            FROM core.role_revocation_requests
            WHERE tenant_id = ${tenantId} AND id = ${request.params.revocationId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Proposal not found");
          assertVersionMatches(expected, current.version, "role_revocation_request");

          if (current.state !== "pending") {
            throw unprocessable("ROLE_REVOCATION_ALREADY_DECIDED", "Proposal is already decided", {
              state: current.state,
            });
          }

          // The DB CHECK blocks the same thing; filtering here first says why it was refused.
          if (current.requested_by_subject_id === session.subjectId) {
            throw unprocessable(
              "ROLE_REVOCATION_SELF_APPROVAL",
              "The proposer cannot approve their own proposal",
              { hint: "Another admin holder decides" },
            );
          }

          const approved = parsed.data.decision === "approve";
          if (approved) {
            // Holders may have changed since the proposal — a wallet disabled, a role revoked.
            const binding = await lockBinding(tx, tenantId, current.role_binding_id);
            await assertApproverRemains(tx, tenantId, binding);
            await tx`
              UPDATE core.role_bindings
              SET revoked_at = now(), version = version + 1
              WHERE tenant_id = ${tenantId} AND id = ${binding.id}
            `;
          }

          await tx`
            UPDATE core.role_revocation_requests
            SET state = ${approved ? "approved" : "rejected"},
                decided_by_subject_id = ${session.subjectId},
                decided_at = now(),
                decision_reason = ${parsed.data.reason},
                version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${current.id}
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: approved ? "admin.role_revocation.approved" : "admin.role_revocation.rejected",
            resourceType: "role_revocation_request",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            correlationId,
            requestIp: request.ip,
            detail: { roleBindingId: current.role_binding_id },
          });

          reply.header("etag", etagOf(current.version + 1));
          const [row] = await readRevocations(tx, tenantId, current.id);
          return toRevocation(row!, requestId, asOf);
        }),
      );
    },
  );
}
