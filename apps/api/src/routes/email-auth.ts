import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import {
  EMAIL_CODE_DIGITS,
  EMAIL_CODE_TTL_MINUTES,
  emailCodeStartRequest,
  emailCodeVerifyRequest,
  normalizeEmail,
} from "@mpc/api-contract";
import { createAccountCrypto, generateEmailCode, type AccountCrypto } from "../account-crypto.js";
import type { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { hashToken, newSessionToken, SESSION_TTL_SECONDS } from "../plugins/session-token.js";
import {
  CODE_ROUTE_MIN_DURATION_MS,
  codeRefusal,
  issuedSessionResponse,
  recordAccountAudit,
  withMinimumDuration,
} from "./account-shared.js";

/**
 * Sign-in with an emailed code — account authentication WP2, plan journey 2.
 *
 * `start` answers the same for every well-formed address (status, body, and time held to a
 * floor), whether it belongs to an account or not; the database writes a decoy for an address
 * without one and mails nothing. `verify` creates a first-factor (`aal1`) session only for the
 * person subject that holds the address, in the same transaction that consumes the code.
 *
 * Limits per address and per requester are counted in the database (0114), so they hold across
 * API replicas and across requester addresses. The in-process cap (`AUTH_RATE_LIMIT_MAX`) sits in
 * front, as for the other sign-in routes.
 */

/** The one answer to "send me a code". */
export const START_MESSAGE =
  "If this address has access, a sign-in code has been sent. It expires in 10 minutes.";

interface StartRow {
  status: "issued" | "rate_limited" | "invitation_invalid";
  retry_after_seconds: number;
  tenant_id: string | null;
  subject_id: string | null;
  invitation_id: string | null;
  email_change_id: string | null;
}

/**
 * Asks the database to start a challenge for `purpose` and audits a real issue. Shared by
 * sign-in and the email-change resend, which answer the same way.
 */
export async function startCodeChallenge(
  sql: postgres.Sql,
  keys: AccountCrypto,
  request: import("fastify").FastifyRequest,
  purpose: "sign_in" | "email_change",
  email: string,
): Promise<void> {
  const code = generateEmailCode();
  const challengeId = randomUUID();
  const emailKey = keys.emailKey(email);

  const row = await sql.begin(async (tx) => {
    const [started] = await tx<StartRow[]>`
      SELECT * FROM core.start_email_challenge(
        ${purpose}::core.email_challenge_purpose, ${email}, NULL, ${challengeId},
        ${keys.codeHmac(purpose, email, code)}, ${code}, ${emailKey}, ${keys.ipKey(request.clientIp)}
      )
    `;
    if (started!.status === "issued" && started!.tenant_id !== null && started!.subject_id !== null) {
      await recordAccountAudit(tx, request, {
        tenantId: started!.tenant_id,
        subjectId: started!.subject_id,
        command: "auth.email_code.issued",
        resourceType: "email_challenge",
        resourceId: challengeId,
        detail: { purpose, emailHash: emailKey },
      });
    }
    return started!;
  });

  if (row.status !== "issued") throw codeRefusal(row.status, row.retry_after_seconds);
}

export async function registerEmailAuthRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  const keys = createAccountCrypto(config.sessionSecret);
  const authRateLimit = { rateLimit: { max: config.authRateLimitMax, timeWindow: "1 minute" } };

  /**
   * The ways in this deployment offers (WP6). Configuration only — the same for every caller —
   * so the sign-in screen draws no button that would answer `OIDC_PROVIDER_DISABLED`.
   */
  app.get("/api/v1/auth/methods", async (request) => ({
    emailCode: true as const,
    google: config.oidc.google !== null,
    microsoft: config.oidc.microsoft !== null,
    emailCodeDigits: EMAIL_CODE_DIGITS,
    emailCodeTtlMinutes: EMAIL_CODE_TTL_MINUTES,
    requestId: request.context.requestId,
  }));

  app.post("/api/v1/auth/email/start", { config: authRateLimit }, async (request, reply) => {
    const parsed = emailCodeStartRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
    }
    const email = normalizeEmail(parsed.data.email)!;

    await withMinimumDuration(CODE_ROUTE_MIN_DURATION_MS, () =>
      startCodeChallenge(sql, keys, request, "sign_in", email),
    );

    reply.code(202);
    return {
      accepted: true as const,
      message: START_MESSAGE,
      expiresInMinutes: EMAIL_CODE_TTL_MINUTES,
      requestId: request.context.requestId,
    };
  });

  app.post("/api/v1/auth/email/verify", { config: authRateLimit }, async (request) => {
    const parsed = emailCodeVerifyRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid");
    }
    const email = normalizeEmail(parsed.data.email)!;
    const emailKey = keys.emailKey(email);
    const token = newSessionToken();
    const sessionId = randomUUID();

    const row = await withMinimumDuration(CODE_ROUTE_MIN_DURATION_MS, () =>
      sql.begin(async (tx) => {
        const [checked] = await tx<
          {
            status: string;
            retry_after_seconds: number;
            tenant_id: string | null;
            subject_id: string | null;
            challenge_id: string | null;
            expires_at: Date | null;
          }[]
        >`
          SELECT * FROM core.verify_sign_in_code(
            ${email}, ${keys.codeHmac("sign_in", email, parsed.data.code)}, ${emailKey},
            ${keys.ipKey(request.clientIp)}, ${sessionId}, ${hashToken(token)}, ${SESSION_TTL_SECONDS}
          )
        `;
        const result = checked!;
        // Only an attempt against a real account's code is audited; a decoy has no tenant.
        if (result.tenant_id !== null && result.subject_id !== null) {
          const created = result.status === "session_created";
          await recordAccountAudit(tx, request, {
            tenantId: result.tenant_id,
            subjectId: result.subject_id,
            command: created ? "auth.email_code.verified" : "auth.email_code.failed",
            resourceType: "email_challenge",
            resourceId: result.challenge_id,
            detail: { purpose: "sign_in", emailHash: emailKey, ...(created ? {} : { reason: result.status }) },
          });
          if (created) {
            await recordAccountAudit(tx, request, {
              tenantId: result.tenant_id,
              subjectId: result.subject_id,
              command: "auth.session.created",
              resourceType: "session",
              resourceId: sessionId,
              detail: { firstFactor: "email_code", aal: "aal1", emailHash: emailKey },
            });
          }
        }
        return result;
      }),
    );

    if (row.status !== "session_created" || row.expires_at === null) {
      throw codeRefusal(row.status, row.retry_after_seconds);
    }
    return issuedSessionResponse(sql, request, token, row.expires_at);
  });
}
