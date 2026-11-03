import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import {
  EMAIL_CODE_TTL_MINUTES,
  createInvitationRequest,
  invitationAcceptStartRequest,
  invitationAcceptVerifyRequest,
  normalizeEmail,
} from "@mpc/api-contract";
import { withTenant } from "@mpc/db";
import { createAccountCrypto, generateEmailCode, generateInvitationToken } from "../account-crypto.js";
import { recordAudit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { hashToken, newSessionToken, SESSION_TTL_SECONDS } from "../plugins/session-token.js";
import {
  CODE_ROUTE_MIN_DURATION_MS,
  codeRefusal,
  issuedSessionResponse,
  recordAccountAudit,
  withMinimumDuration,
} from "./account-shared.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Invitations — account authentication WP2, plan journey 1 and decisions D5/D6.
 *
 * An admin invites an address into an organisation of their tenant. The invitation carries **no
 * role**: the new account is created with none and the lowest identity assurance, and roles are
 * granted afterwards through the two-person role grant. Accepting needs the link (a 256-bit token
 * stored only as a hash) **and** a code mailed to the invited address, so a forwarded or leaked
 * link alone does not make an account.
 *
 * An address that already belongs to a subject, or has an open invitation or email change, in
 * any tenant, cannot be invited. Every such refusal gives the one code
 * `INVITATION_EMAIL_UNAVAILABLE` (D6: the admin learns that the address is in use, not where),
 * and is audited with a keyed hash of the address.
 *
 * The link is `<WEB_ORIGIN>/invitations/accept#token=…`. The token is in the fragment, which a
 * browser never sends to a server, so it stays out of access logs and `Referer` headers.
 */

interface InvitationRow {
  id: string;
  email: string;
  organization_id: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  invited_by_subject_id: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_subject_id: string | null;
  revoked_at: Date | null;
  closed_reason: "inviter_suspended" | null;
  version: number;
}

class EmailUnavailable extends Error {}

function toInvitation(row: InvitationRow, requestId: string, asOf: string) {
  const expired = row.state === "pending" && row.expires_at.getTime() <= Date.parse(asOf);
  return {
    id: row.id,
    email: row.email,
    organizationId: row.organization_id,
    state: expired ? ("expired" as const) : row.state,
    invitedBySubjectId: row.invited_by_subject_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    acceptedSubjectId: row.accepted_subject_id,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    closedReason: row.closed_reason,
    version: row.version,
    requestId,
    asOf,
  };
}

const INVITATION_COLUMNS = (tx: postgres.TransactionSql) => tx`
  id, email, organization_id, state, invited_by_subject_id, created_at, expires_at,
  accepted_at, accepted_subject_id, revoked_at, closed_reason, version
`;

export async function registerInvitationRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  const keys = createAccountCrypto(config.sessionSecret);
  const authRateLimit = { rateLimit: { max: config.authRateLimitMax, timeWindow: "1 minute" } };

  // --- Admin --------------------------------------------------------------

  app.get("/api/v1/admin/invitations", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "admin.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );
    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => tx<InvitationRow[]>`
      SELECT ${INVITATION_COLUMNS(tx)} FROM core.invitations
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 500
    `);
    return { items: rows.map((row) => toInvitation(row, requestId, asOf)), requestId, asOf };
  });

  app.post("/api/v1/admin/invitations", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.invitation.manage",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const parsed = createInvitationRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
    }
    const email = normalizeEmail(parsed.data.email)!;
    const emailHash = keys.emailKey(email);
    const { requestId, asOf, correlationId } = request.context;

    const token = generateInvitationToken();
    const id = randomUUID();
    const link = `${config.webOrigin}/invitations/accept#token=${token}`;

    try {
      return await withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [created] = await tx<{ status: string }[]>`
            SELECT status FROM core.create_invitation(
              ${id}, ${parsed.data.organizationId}, ${email}, ${session.subjectId},
              ${hashToken(token)}, ${link}
            )
          `;
          if (created!.status === "organization_unknown") {
            throw unprocessable("ORGANIZATION_UNKNOWN", "The organisation is not in this workspace");
          }
          if (created!.status === "unavailable") throw new EmailUnavailable();

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "admin.invitation.created",
            resourceType: "invitation",
            resourceId: id,
            afterVersion: 1,
            correlationId,
            requestIp: request.clientIp,
            detail: { emailHash, organizationId: parsed.data.organizationId },
          });

          const [row] = await tx<InvitationRow[]>`
            SELECT ${INVITATION_COLUMNS(tx)} FROM core.invitations WHERE id = ${id}
          `;
          return toInvitation(row!, requestId, asOf);
        }),
      );
    } catch (caught) {
      if (!(caught instanceof EmailUnavailable)) throw caught;
      // The refusal is recorded in its own transaction: the one that tried has rolled back.
      await withTenant(sql, { tenantId }, (tx) =>
        recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "admin.invitation.refused",
          resourceType: "invitation",
          correlationId,
          requestIp: request.clientIp,
          detail: { emailHash, organizationId: parsed.data.organizationId, reason: "email_unavailable" },
        }),
      );
      throw conflict("INVITATION_EMAIL_UNAVAILABLE", "This address cannot be invited");
    }
  });

  app.post<{ Params: { invitationId: string } }>(
    "/api/v1/admin/invitations/:invitationId/revoke",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.invitation.manage",
        tenantResource(tenantId, { state: "pending", statesAllowingAction: ["pending"] }),
        sessionFacts(session),
      );
      const expected = requireIfMatch(request);
      const { requestId, asOf, correlationId } = request.context;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [revoked] = await tx<{ status: string; version: number | null }[]>`
            SELECT * FROM core.revoke_invitation(${request.params.invitationId}, ${session.subjectId}, ${expected})
          `;
          switch (revoked!.status) {
            case "not_found":
              throw notFound("Invitation not found");
            case "version_mismatch":
              assertVersionMatches(expected, revoked!.version!, "invitation");
              break;
            case "not_pending":
              throw unprocessable("INVITATION_NOT_PENDING", "Only a pending invitation can be revoked");
          }

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "admin.invitation.revoked",
            resourceType: "invitation",
            resourceId: request.params.invitationId,
            beforeVersion: expected,
            afterVersion: revoked!.version!,
            correlationId,
            requestIp: request.clientIp,
          });

          reply.header("etag", etagOf(revoked!.version!));
          const [row] = await tx<InvitationRow[]>`
            SELECT ${INVITATION_COLUMNS(tx)} FROM core.invitations WHERE id = ${request.params.invitationId}
          `;
          return toInvitation(row!, requestId, asOf);
        }),
      );
    },
  );

  // --- Acceptance (unauthenticated) ----------------------------------------

  app.post("/api/v1/auth/invitations/accept/start", { config: authRateLimit }, async (request) => {
    const parsed = invitationAcceptStartRequest.safeParse(request.body);
    if (!parsed.success) throw badRequest("REQUEST_INVALID", "Request format is invalid");
    const tokenHash = hashToken(parsed.data.token);
    const code = generateEmailCode();
    const challengeId = randomUUID();

    const row = await withMinimumDuration(CODE_ROUTE_MIN_DURATION_MS, () =>
      sql.begin(async (tx) => {
        const [started] = await tx<
          { status: string; retry_after_seconds: number; tenant_id: string | null; invitation_id: string | null }[]
        >`
          SELECT * FROM core.start_email_challenge(
            'invitation'::core.email_challenge_purpose, NULL, ${tokenHash}, ${challengeId},
            ${keys.codeHmac("invitation", tokenHash, code)}, ${code}, NULL, ${keys.ipKey(request.clientIp)}
          )
        `;
        if (started!.status === "issued" && started!.tenant_id !== null) {
          await recordAccountAudit(tx, request, {
            tenantId: started!.tenant_id,
            subjectId: null,
            command: "auth.email_code.issued",
            resourceType: "email_challenge",
            resourceId: challengeId,
            detail: { purpose: "invitation", invitationId: started!.invitation_id },
          });
        }
        return started!;
      }),
    );
    if (row.status !== "issued") throw codeRefusal(row.status, row.retry_after_seconds);

    return {
      accepted: true as const,
      expiresInMinutes: EMAIL_CODE_TTL_MINUTES,
      requestId: request.context.requestId,
    };
  });

  app.post("/api/v1/auth/invitations/accept/verify", { config: authRateLimit }, async (request) => {
    const parsed = invitationAcceptVerifyRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", { issues: parsed.error.issues });
    }
    const tokenHash = hashToken(parsed.data.token);
    const subjectId = randomUUID();
    const sessionToken = newSessionToken();
    const sessionId = randomUUID();

    const row = await withMinimumDuration(CODE_ROUTE_MIN_DURATION_MS, () =>
      sql.begin(async (tx) => {
        const [accepted] = await tx<
          {
            status: string;
            retry_after_seconds: number;
            tenant_id: string | null;
            subject_id: string | null;
            organization_id: string | null;
            invitation_id: string | null;
            challenge_id: string | null;
            expires_at: Date | null;
          }[]
        >`
          SELECT * FROM core.accept_invitation(
            ${tokenHash}, ${keys.codeHmac("invitation", tokenHash, parsed.data.code)},
            ${keys.ipKey(request.clientIp)}, ${subjectId}, ${parsed.data.displayName},
            ${sessionId}, ${hashToken(sessionToken)}, ${SESSION_TTL_SECONDS}
          )
        `;
        const result = accepted!;
        if (result.tenant_id === null) return result;

        if (result.status !== "session_created") {
          await recordAccountAudit(tx, request, {
            tenantId: result.tenant_id,
            subjectId: null,
            command: "auth.email_code.failed",
            resourceType: "email_challenge",
            resourceId: result.challenge_id,
            detail: { purpose: "invitation", invitationId: result.invitation_id, reason: result.status },
          });
          return result;
        }

        await tx`SELECT set_config('app.current_tenant', ${result.tenant_id}, true)`;
        const emailHash = await tx<{ email: string }[]>`
          SELECT email FROM core.invitations WHERE id = ${result.invitation_id}
        `.then(([invitation]) => keys.emailKey(invitation!.email));
        for (const entry of [
          {
            command: "auth.invitation.accepted",
            resourceType: "invitation",
            resourceId: result.invitation_id,
            detail: { emailHash, organizationId: result.organization_id },
          },
          {
            command: "auth.email_code.verified",
            resourceType: "email_challenge",
            resourceId: result.challenge_id,
            detail: { purpose: "invitation", invitationId: result.invitation_id },
          },
          {
            command: "auth.session.created",
            resourceType: "session",
            resourceId: sessionId,
            detail: { firstFactor: "email_code", aal: "aal1", emailHash },
          },
        ]) {
          await recordAccountAudit(tx, request, {
            tenantId: result.tenant_id,
            subjectId: result.subject_id,
            ...entry,
          });
        }
        return result;
      }),
    );

    if (row.status === "email_unavailable") throw codeRefusal("invitation_invalid", null);
    if (row.status !== "session_created" || row.expires_at === null) {
      throw codeRefusal(row.status, row.retry_after_seconds);
    }
    return issuedSessionResponse(sql, request, sessionToken, row.expires_at);
  });
}
