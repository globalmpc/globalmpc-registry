import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyRequest } from "fastify";
import type postgres from "postgres";
import { ACCOUNT_RECOVERY_SEPARATION_REQUIRED, SUBJECT_SUSPENDED } from "@mpc/api-contract";
import { ROLE_SELF_BOUND, recordAudit } from "../audit.js";
import { hashUserAgent } from "../device.js";
import { AppError, tooManyRequests, unauthorized, unprocessable } from "../errors.js";
import { resolveSession, type Session } from "../plugins/session.js";
import { resolveSessionToken } from "../plugins/session-token.js";
import { sessionView } from "./auth.js";

/**
 * Shared pieces of the unauthenticated account routes (emailed codes, invitation acceptance,
 * email change).
 */

/**
 * The shortest time an unauthenticated code route takes to answer.
 *
 * The database does the same writes for an address with an account and one without (0114's
 * decoys), but an account also gets an audit row and the timing of one insert is measurable in
 * aggregate. Every answer — success or refusal — is held back to this floor, so what the
 * requester can time is the floor, not the work. It is far above the work the routes do, and far
 * below anything a person notices.
 */
export const CODE_ROUTE_MIN_DURATION_MS = 250;

export async function withMinimumDuration<T>(minimumMs: number, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const remaining = minimumMs - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);
  }
}

/**
 * The actor of an audit row written before (or without) a session — a code being asked for or
 * checked. The subject is the account the code belongs to; no role decided it (`self_bound`).
 */
function accountActor(
  subjectId: string | null,
  tenantId: string,
  userAgentHash: string | null,
): Session {
  return {
    principal: "person",
    sessionId: "",
    subjectId,
    tenantId,
    assuranceLevel: "wallet_only",
    firstFactor: null,
    secondFactor: null,
    aal: null,
    recoveryLimited: false,
    roleBindings: [],
    narrowedRoles: [],
    projectIds: [],
    device: { userAgentHash },
  };
}

export interface AccountAuditEntry {
  readonly tenantId: string;
  readonly subjectId: string | null;
  readonly command: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly detail?: Record<string, unknown>;
}

/**
 * Writes an account audit row inside `tx`, setting the tenant for that transaction first: these
 * routes start without one, and `audit.events` is tenant-scoped (0078).
 *
 * Addresses go into `detail` only as keyed hashes (`emailHash`), never in plain text.
 */
export async function recordAccountAudit(
  tx: postgres.TransactionSql,
  request: FastifyRequest,
  entry: AccountAuditEntry,
): Promise<void> {
  await tx`SELECT set_config('app.current_tenant', ${entry.tenantId}, true)`;
  await recordAudit(tx, {
    tenantId: entry.tenantId,
    session: accountActor(entry.subjectId, entry.tenantId, hashUserAgent(request.headers["user-agent"])),
    effectiveRole: ROLE_SELF_BOUND,
    command: entry.command,
    resourceType: entry.resourceType,
    ...(entry.resourceId ? { resourceId: entry.resourceId } : {}),
    correlationId: request.context.correlationId,
    requestIp: request.clientIp,
    ...(entry.detail ? { detail: entry.detail } : {}),
  });
}

/**
 * The email-change, MFA-reset and suspension routes' refusal when the actor took part in one of
 * the other flows for the same person within 30 days (0118, 0128). One answer for all three flows
 * and every position (proposer or decider), so it says which rule, not which earlier request.
 */
export function recoverySeparationRequired(): AppError {
  return unprocessable(
    ACCOUNT_RECOVERY_SEPARATION_REQUIRED,
    "Someone who took part in a recent email change, MFA reset or suspension of this person cannot take part in another",
    { hint: "Admins who were not involved in those requests propose and decide this one" },
  );
}

/**
 * The admin email-change and MFA-reset routes' refusal for a suspended person (0128). Only admins
 * see it; the public email-change verify answers a wrong code instead.
 */
export function subjectSuspended(): AppError {
  return unprocessable(SUBJECT_SUSPENDED, "This person is suspended", {
    hint: "Two administrators reinstate the person first; reinstating opens a window to set up new factors",
  });
}

/** A refusal from the database's code check, as the API answers it. */
export function codeRefusal(status: string, retryAfterSeconds: number | null): AppError {
  switch (status) {
    case "rate_limited":
      return tooManyRequests("RATE_LIMITED", "Too many attempts. Try again later", {
        retryAfterSeconds: String(retryAfterSeconds ?? 60),
      });
    case "code_expired":
      return unauthorized("EMAIL_CODE_EXPIRED", "This code has expired. Ask for a new one");
    case "attempts_exhausted":
      return unauthorized("EMAIL_CODE_ATTEMPTS_EXHAUSTED", "Too many wrong codes. Ask for a new one");
    case "invitation_invalid":
      return new AppError(
        "INVITATION_INVALID",
        "This invitation cannot be used. It may have expired, been used or been revoked",
        404,
        false,
      );
    default:
      return unauthorized("EMAIL_CODE_INVALID", "The code is not valid");
  }
}

/**
 * The response to a code that created a session: the same session view the session route shows,
 * with the token, issued once.
 */
export async function issuedSessionResponse(
  sql: postgres.Sql,
  request: FastifyRequest,
  token: string,
  expiresAt: Date,
) {
  const row = await resolveSessionToken(sql, token);
  const session = row ? await resolveSession(sql, row) : null;
  if (!session) {
    throw unauthorized("SESSION_NOT_ISSUED", "The session could not be established");
  }
  return {
    ...sessionView(session),
    sessionToken: token,
    expiresAt: expiresAt.toISOString(),
    credentials: [],
    organizationIds: [],
    requestId: request.context.requestId,
    asOf: request.context.asOf,
  };
}
