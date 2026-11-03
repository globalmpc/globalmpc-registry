import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import {
  createSubjectSuspensionRequest,
  decideSubjectSuspensionRequest,
  SUSPENSION_STATE_CONFLICT,
} from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import { recordAudit } from "../audit.js";
import { AppError, badRequest, conflict, notFound, preconditionFailed, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recoverySeparationRequired } from "./account-shared.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Suspending and reinstating a person — plan journey 6, AUTH-06 (migration 0127).
 *
 * Two people with an admin role at aal3 (the roles' minimum level): one proposes, another decides,
 * and neither is the person. The decision runs `core.decide_subject_suspension`, which does all
 * of it in the request's transaction — on suspension: mark the person, end every session, revoke
 * every second factor, recovery code and linked identity, drop open ceremonies and pending
 * sign-in codes, queue the notice; on reinstatement: clear the mark, open a 24-hour enrolment
 * window, queue the notice. Nothing signed is touched.
 *
 * While suspended, sign-in answers exactly as for an unknown address or identity (the database
 * functions decide that, not this file).
 */

type Tx = postgres.TransactionSql;

/** A request an approved suspension closed (0128, 0132): its table, id and why. */
interface ClosedRequest {
  kind: string;
  id: string;
  reason: "subject_suspended" | "proposer_suspended" | "window_closed" | "approver_suspended" | "inviter_suspended";
}

interface SuspensionRow {
  id: string;
  subject_id: string;
  subject_name: string;
  action: "suspend" | "reinstate";
  reason: string;
  requested_by_subject_id: string;
  requested_at: Date;
  state: "pending" | "approved" | "rejected";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  enrolment_window_until: Date | null;
  closed_reason: "proposer_suspended" | null;
  version: number;
}

function readSuspensions(tx: Tx, suspensionId?: string) {
  return tx<SuspensionRow[]>`
    SELECT r.id, r.subject_id, s.display_name AS subject_name, r.action, r.reason,
           r.requested_by_subject_id, r.requested_at, r.state, r.decided_by_subject_id, r.decided_at,
           r.decision_reason, r.enrolment_window_until, r.closed_reason, r.version
    FROM core.subject_suspensions r
    JOIN core.subjects s ON s.id = r.subject_id
    WHERE (${suspensionId ?? null}::uuid IS NULL OR r.id = ${suspensionId ?? null})
    ORDER BY r.requested_at DESC
  `;
}

function toSuspension(row: SuspensionRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    action: row.action,
    reason: row.reason,
    requestedBySubjectId: row.requested_by_subject_id,
    requestedAt: row.requested_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    enrolmentWindowUntil: row.enrolment_window_until?.toISOString() ?? null,
    closedReason: row.closed_reason,
    version: row.version,
    requestId,
    asOf,
  };
}


async function inTenant<T>(sql: postgres.Sql, tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(sql, { tenantId }, work);
  } catch (caught) {
    throw translate(caught);
  }
}

export async function registerSubjectSuspensionRoutes(app: FastifyInstance, sql: postgres.Sql): Promise<void> {
  const activeTenant = (tenantId: string) =>
    tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] });

  app.get("/api/v1/admin/subject-suspensions", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(session, "admin.read", activeTenant(tenantId), sessionFacts(session));
    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => readSuspensions(tx));
    return { items: rows.map((row) => toSuspension(row, requestId, asOf)), requestId, asOf };
  });

  app.post("/api/v1/admin/subject-suspensions", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.subject_suspension.propose",
      activeTenant(tenantId),
      sessionFacts(session),
    );
    const parsed = createSubjectSuspensionRequest.safeParse(request.body);
    if (!parsed.success) throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
    if (parsed.data.subjectId === session.subjectId) {
      throw unprocessable("SUSPENSION_SELF_TARGET", "Nobody proposes or decides their own suspension");
    }

    const { requestId, asOf, correlationId } = request.context;
    return inTenant(sql, tenantId, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
        const [target] = await tx<{ kind: string }[]>`
          SELECT kind FROM core.subjects WHERE id = ${parsed.data.subjectId}
        `;
        // A service holds a service token, revoked on its own (D7); it has no sign-in to suspend.
        if (!target || target.kind !== "person") throw notFound("Person not found");

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.subject_suspensions (id, tenant_id, subject_id, action, reason, requested_by_subject_id)
            VALUES (
              ${id}, ${tenantId}, ${parsed.data.subjectId}, ${parsed.data.action}, ${parsed.data.reason},
              ${session.subjectId}
            )
          `;
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes("subject_suspensions_one_pending")) {
            throw conflict("SUSPENSION_ALREADY_PENDING", "A request for this person is already waiting for a decision");
          }
          throw translate(caught);
        }

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: `admin.subject_suspension.${parsed.data.action}_proposed`,
          resourceType: "subject_suspension",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.clientIp,
          detail: { subjectId: parsed.data.subjectId, action: parsed.data.action },
        });

        const [row] = await readSuspensions(tx, id);
        return toSuspension(row!, requestId, asOf);
      }),
    );
  });

  app.post<{ Params: { suspensionId: string } }>(
    "/api/v1/admin/subject-suspensions/:suspensionId/decision",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.subject_suspension.approve",
        tenantResource(tenantId, { state: "pending", statesAllowingAction: ["pending"] }),
        sessionFacts(session),
      );
      // If-Match before the body — a missing header must not hide behind a body error.
      const expected = requireIfMatch(request);
      const parsed = decideSubjectSuspensionRequest.safeParse(request.body);
      if (!parsed.success) throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });

      const { requestId, asOf, correlationId } = request.context;
      return inTenant(sql, tenantId, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [current] = await readSuspensions(tx, request.params.suspensionId);
          if (!current) throw notFound("Suspension request not found");
          assertVersionMatches(expected, current.version, "subject_suspension");
          if (current.state !== "pending") {
            throw unprocessable("SUSPENSION_ALREADY_DECIDED", "The request is already decided", { state: current.state });
          }
          // The database refuses both as well; checking here says why.
          if (current.requested_by_subject_id === session.subjectId) throw DB_REFUSALS["SUSPENSION_SELF_APPROVAL"]!();
          if (current.subject_id === session.subjectId) throw DB_REFUSALS["SUSPENSION_SELF_TARGET"]!();

          const approved = parsed.data.decision === "approve";
          const [effect] = await tx<
            {
              revoked_sessions: number;
              revoked_authenticators: number;
              revoked_identities: number;
              new_version: number;
              closed_requests: ClosedRequest[];
            }[]
          >`
            SELECT * FROM core.decide_subject_suspension(
              ${current.id}, ${session.subjectId}, ${approved}, ${parsed.data.reason}, ${expected}
            )
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: `admin.subject_suspension.${current.action}_${approved ? "approved" : "rejected"}`,
            resourceType: "subject_suspension",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: effect!.new_version,
            correlationId,
            requestIp: request.clientIp,
            detail: {
              subjectId: current.subject_id,
              action: current.action,
              revokedSessions: effect!.revoked_sessions,
              revokedAuthenticators: effect!.revoked_authenticators,
              revokedIdentities: effect!.revoked_identities,
              closedRequests: effect!.closed_requests.length,
            },
          });

          // 0128: each request the suspension closed — the person's open recovery requests, what
          // they proposed and (0132) what they approved or invited that is still open — gets an
          // audit row of its own, attributed to this decision.
          for (const closed of effect!.closed_requests) {
            await recordAudit(tx, {
              tenantId,
              session,
              effectiveRole,
              command: "admin.subject_suspension.request_closed",
              resourceType: closed.kind,
              resourceId: closed.id,
              correlationId,
              requestIp: request.clientIp,
              detail: { subjectId: current.subject_id, suspensionId: current.id, reason: closed.reason },
            });
          }

          reply.header("etag", etagOf(effect!.new_version));
          const [row] = await readSuspensions(tx, current.id);
          return toSuspension(row!, requestId, asOf);
        }),
      );
    },
  );
}

// Refusals the decision function raises, mapped to answers. Kept after the routes so each
// separation code sits under the action that raises it (`second-person-coverage.test.ts`).

function stateConflict(): AppError {
  return unprocessable(
    SUSPENSION_STATE_CONFLICT,
    "Only an active person can be suspended, and only a suspended one reinstated",
  );
}

const DB_REFUSALS: Readonly<Record<string, () => AppError>> = {
  SUSPENSION_NOT_FOUND: () => notFound("Suspension request not found"),
  SUSPENSION_NOT_A_PERSON: () => notFound("Person not found"),
  SUSPENSION_VERSION_MISMATCH: () =>
    preconditionFailed("RESOURCE_VERSION_MISMATCH", "This resource changed after it was read. Reread and decide again."),
  SUSPENSION_ALREADY_DECIDED: () => unprocessable("SUSPENSION_ALREADY_DECIDED", "The request is already decided"),
  SUSPENSION_STATE_CONFLICT: stateConflict,
  // 0118 / 0127: a reinstatement opens an enrolment window, so whoever took part in a recent email
  // change of the person takes no part in it (and the reverse).
  SUSPENSION_SEPARATION_REQUIRED: () => recoverySeparationRequired(),
  SUSPENSION_SELF_APPROVAL: () =>
    unprocessable("SUSPENSION_SELF_APPROVAL", "The proposer cannot decide their own proposal", {
      hint: "Another admin decides",
    }),
  SUSPENSION_SELF_TARGET: () => unprocessable("SUSPENSION_SELF_TARGET", "Nobody proposes or decides their own suspension"),
};

function translate(caught: unknown): unknown {
  if (!(caught instanceof Error)) return caught;
  const code = /^(SUSPENSION_[A-Z_]+):/.exec(caught.message)?.[1];
  return code !== undefined && code in DB_REFUSALS ? DB_REFUSALS[code]!() : caught;
}
