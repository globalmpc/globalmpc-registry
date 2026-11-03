import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import {
  EMAIL_CHANGE_NO_ADDRESS,
  EMAIL_CODE_TTL_MINUTES,
  createEmailChangeRequest,
  decideEmailChangeRequest,
  emailChangeStartRequest,
  emailChangeVerifyRequest,
  normalizeEmail,
} from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import { createAccountCrypto, generateEmailCode } from "../account-crypto.js";
import { recordAudit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import {
  CODE_ROUTE_MIN_DURATION_MS,
  codeRefusal,
  recordAccountAudit,
  recoverySeparationRequired,
  subjectSuspended,
  withMinimumDuration,
} from "./account-shared.js";
import { START_MESSAGE, startCodeChallenge } from "./email-auth.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Email change — account authentication WP2, plan journey 7.
 *
 * The address is where a person's sign-in code goes, so changing it changes their login. Hence:
 *
 * 1. an admin proposes a new address for **another** person (nobody proposes their own);
 * 2. a **second** admin, neither the proposer nor the person, approves it — the database refuses
 *    both self-decisions (0113 constraints, 0114 `core.decide_email_change`);
 * 3. approval mails a code to the new address; the change completes only with that code, which
 *    proves the new address is reachable by its holder;
 * 4. completing swaps the address, ends **every** session of the person and tells the old address.
 *
 * Admins never write an address directly: the application role has no privilege on
 * `core.subjects.email` (0112). Every step is audited, addresses only as keyed hashes.
 */

interface ChangeRow {
  id: string;
  subject_id: string;
  new_email: string;
  reason: string;
  requested_by_subject_id: string;
  requested_at: Date;
  state: "pending" | "approved" | "rejected" | "completed" | "expired";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  completed_at: Date | null;
  closed_reason: "subject_suspended" | "proposer_suspended" | "approver_suspended" | null;
  version: number;
}

/**
 * The columns the API reads — exactly the ones the application role may SELECT (0119, 0133). Never
 * `SELECT *`: `previous_email` (the address a completed change moved away from, kept only for
 * the reset notice) is not readable by the application role, and a `*` would fail on it.
 */
const CHANGE_COLUMNS = `id, subject_id, new_email, reason, requested_by_subject_id, requested_at, state,
  decided_by_subject_id, decided_at, decision_reason, completed_at, closed_reason, version`;

function toChange(row: ChangeRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    newEmail: row.new_email,
    reason: row.reason,
    requestedBySubjectId: row.requested_by_subject_id,
    requestedAt: row.requested_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    completedAt: row.completed_at?.toISOString() ?? null,
    closedReason: row.closed_reason,
    version: row.version,
    requestId,
    asOf,
  };
}

class EmailUnavailable extends Error {}

export async function registerEmailChangeRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  const keys = createAccountCrypto(config.sessionSecret);
  const authRateLimit = { rateLimit: { max: config.authRateLimitMax, timeWindow: "1 minute" } };

  const readChange = async (tx: postgres.TransactionSql, id: string) => {
    const [row] = await tx<ChangeRow[]>`
      SELECT ${tx.unsafe(CHANGE_COLUMNS)} FROM core.email_change_requests WHERE id = ${id}
    `;
    return row;
  };

  // --- Admin --------------------------------------------------------------

  app.get("/api/v1/admin/email-changes", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "admin.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );
    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => tx<ChangeRow[]>`
      SELECT ${tx.unsafe(CHANGE_COLUMNS)} FROM core.email_change_requests
      WHERE tenant_id = ${tenantId}
      ORDER BY requested_at DESC
      LIMIT 500
    `);
    return { items: rows.map((row) => toChange(row, requestId, asOf)), requestId, asOf };
  });

  app.post("/api/v1/admin/email-changes", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.email_change.propose",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );
    const parsed = createEmailChangeRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
    }
    const email = normalizeEmail(parsed.data.newEmail)!;
    const emailHash = keys.emailKey(email);
    const { requestId, asOf, correlationId } = request.context;
    const id = randomUUID();

    try {
      return await withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [created] = await tx<{ status: string }[]>`
            SELECT status FROM core.request_email_change(
              ${id}, ${parsed.data.subjectId}, ${email}, ${parsed.data.reason}, ${session.subjectId}
            )
          `;
          switch (created!.status) {
            case "subject_invalid":
              throw notFound("Subject not found");
            case "self":
              throw unprocessable("EMAIL_CHANGE_SELF", "Nobody can change their own address", {
                hint: "Another admin proposes it, and a third person decides",
              });
            case "already_open":
              throw conflict("EMAIL_CHANGE_ALREADY_OPEN", "This person already has an open email change");
            case "no_address":
              // 0118: attaching a first address is invitation acceptance, never a change.
              throw unprocessable(EMAIL_CHANGE_NO_ADDRESS, "This person has no address to change", {
                hint: "Invite the person by email; the invitation creates their account",
              });
            case "separation_required":
              throw recoverySeparationRequired();
            case "subject_suspended":
              throw subjectSuspended();
            case "unavailable":
              throw new EmailUnavailable();
          }

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "admin.email_change.proposed",
            resourceType: "email_change_request",
            resourceId: id,
            afterVersion: 1,
            correlationId,
            requestIp: request.clientIp,
            detail: { subjectId: parsed.data.subjectId, newEmailHash: emailHash },
          });
          return toChange((await readChange(tx, id))!, requestId, asOf);
        }),
      );
    } catch (caught) {
      if (!(caught instanceof EmailUnavailable)) throw caught;
      await withTenant(sql, { tenantId }, (tx) =>
        recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "admin.email_change.refused",
          resourceType: "email_change_request",
          correlationId,
          requestIp: request.clientIp,
          detail: { subjectId: parsed.data.subjectId, newEmailHash: emailHash, reason: "email_unavailable" },
        }),
      );
      throw conflict("EMAIL_CHANGE_EMAIL_UNAVAILABLE", "This address cannot be used");
    }
  });

  app.post<{ Params: { changeId: string } }>(
    "/api/v1/admin/email-changes/:changeId/decision",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.email_change.approve",
        tenantResource(tenantId, { state: "pending", statesAllowingAction: ["pending"] }),
        sessionFacts(session),
      );
      const expected = requireIfMatch(request);
      const parsed = decideEmailChangeRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
      }
      const { requestId, asOf, correlationId } = request.context;
      const approve = parsed.data.decision === "approve";

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const current = await readChange(tx, request.params.changeId);
          if (!current) throw notFound("Email change request not found");

          const code = generateEmailCode();
          const challengeId = randomUUID();
          const [decided] = await tx<{ status: string; version: number | null; subject_id: string | null }[]>`
            SELECT * FROM core.decide_email_change(
              ${current.id}, ${session.subjectId}, ${approve}, ${parsed.data.reason}, ${expected},
              ${challengeId}, ${keys.codeHmac("email_change", current.new_email, code)}, ${code}
            )
          `;
          switch (decided!.status) {
            case "not_found":
              throw notFound("Email change request not found");
            case "version_mismatch":
              assertVersionMatches(expected, decided!.version!, "email_change_request");
              break;
            case "not_pending":
              throw unprocessable("EMAIL_CHANGE_ALREADY_DECIDED", "This request is already decided");
            case "self_approval":
              throw unprocessable("EMAIL_CHANGE_SELF_APPROVAL", "The proposer cannot decide their own proposal", {
                hint: "Another admin holder decides",
              });
            case "self_target":
              throw unprocessable("EMAIL_CHANGE_SELF_TARGET", "The person whose address changes cannot decide it", {
                hint: "An admin holder other than the proposer and the person decides",
              });
            case "separation_required":
              throw recoverySeparationRequired();
            case "subject_suspended":
              throw subjectSuspended();
          }

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: approve ? "admin.email_change.approved" : "admin.email_change.rejected",
            resourceType: "email_change_request",
            resourceId: current.id,
            beforeVersion: expected,
            afterVersion: decided!.version!,
            correlationId,
            requestIp: request.clientIp,
            detail: { subjectId: current.subject_id },
          });
          if (approve) {
            await recordAccountAudit(tx, request, {
              tenantId,
              subjectId: current.subject_id,
              command: "auth.email_code.issued",
              resourceType: "email_challenge",
              resourceId: challengeId,
              detail: { purpose: "email_change", emailHash: keys.emailKey(current.new_email), emailChangeId: current.id },
            });
          }

          reply.header("etag", etagOf(decided!.version!));
          return toChange((await readChange(tx, current.id))!, requestId, asOf);
        }),
      );
    },
  );

  // --- Verification (unauthenticated) ---------------------------------------

  app.post("/api/v1/auth/email-change/start", { config: authRateLimit }, async (request, reply) => {
    const parsed = emailChangeStartRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
    }
    const email = normalizeEmail(parsed.data.email)!;
    await withMinimumDuration(CODE_ROUTE_MIN_DURATION_MS, () =>
      startCodeChallenge(sql, keys, request, "email_change", email),
    );
    reply.code(202);
    return {
      accepted: true as const,
      message: START_MESSAGE,
      expiresInMinutes: EMAIL_CODE_TTL_MINUTES,
      requestId: request.context.requestId,
    };
  });

  app.post("/api/v1/auth/email-change/verify", { config: authRateLimit }, async (request) => {
    const parsed = emailChangeVerifyRequest.safeParse(request.body);
    if (!parsed.success) throw badRequest("REQUEST_INVALID", "Request format is invalid");
    const email = normalizeEmail(parsed.data.email)!;
    const emailKey = keys.emailKey(email);

    const row = await withMinimumDuration(CODE_ROUTE_MIN_DURATION_MS, () =>
      sql.begin(async (tx) => {
        const [completed] = await tx<
          {
            status: string;
            retry_after_seconds: number;
            tenant_id: string | null;
            subject_id: string | null;
            email_change_id: string | null;
            previous_email: string | null;
            revoked_sessions: number;
          }[]
        >`
          SELECT * FROM core.complete_email_change(
            ${email}, ${keys.codeHmac("email_change", email, parsed.data.code)}, ${emailKey},
            ${keys.ipKey(request.clientIp)}
          )
        `;
        const result = completed!;
        if (result.tenant_id === null || result.subject_id === null) return result;

        if (result.status !== "completed") {
          await recordAccountAudit(tx, request, {
            tenantId: result.tenant_id,
            subjectId: result.subject_id,
            command: "auth.email_code.failed",
            resourceType: "email_challenge",
            resourceId: result.email_change_id,
            detail: { purpose: "email_change", emailHash: emailKey, reason: result.status },
          });
          return result;
        }
        await recordAccountAudit(tx, request, {
          tenantId: result.tenant_id,
          subjectId: result.subject_id,
          command: "auth.email_change.completed",
          resourceType: "email_change_request",
          resourceId: result.email_change_id,
          detail: {
            newEmailHash: emailKey,
            previousEmailHash: result.previous_email === null ? null : keys.emailKey(result.previous_email),
            revokedSessions: result.revoked_sessions,
          },
        });
        return result;
      }),
    );

    if (row.status === "email_unavailable") {
      throw conflict("EMAIL_CHANGE_EMAIL_UNAVAILABLE", "This address cannot be used");
    }
    if (row.status !== "completed") throw codeRefusal(row.status, row.retry_after_seconds);
    return { completed: true as const, sessionsRevoked: true as const, requestId: request.context.requestId };
  });
}
