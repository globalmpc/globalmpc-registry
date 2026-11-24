import type { ActorContext } from "@mpc/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { ACTION_POLICIES, type FirstFactor, type SecondFactor } from "@mpc/api-contract";
import { withActor } from "@mpc/db";
import { ROLE_SELF_BOUND, recordAudit } from "../audit.js";
import { hashUserAgent } from "../device.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { holdsActionRole } from "../plugins/authorize.js";
import type { Session } from "../plugins/session.js";
import { extractBearerToken, revokeSessionToken } from "../plugins/session-token.js";

/**
 * What a screen may see of a session.
 *
 * Per-organization project lists and jurisdictions are authorization internals; screens get the
 * effective roles, the narrowed ones, and the action list.
 *
 * A first-factor-only (`aal1`) session sees none of that: only who it is, the factors it proved
 * and its level, which is what the MFA step needs. Its roles are not effective (priority rule 2),
 * and listing them would tell whoever holds a stolen first factor which account is worth the
 * second one.
 */
export function sessionView(session: Session) {
  const {
    organizationProjectIds: _projects,
    projectJurisdictions: _jurisdictions,
    device: _device,
    principal: _principal,
    serviceScopes: _scopes,
    sessionId: _id,
    ...visible
  } = session;
  return {
    ...visible,
    aal: session.aal ?? "aal1",
    mfaSatisfied: Boolean(session.secondFactor && !session.recoveryLimited),
    actions: Object.keys(ACTION_POLICIES).filter(action => holdsActionRole(session, action)),
  };
}

/**
 * Session routes shared by every sign-in method: sign-out and the current session.
 *
 * Sessions are issued by the account flows (emailed code, invitation, Google); no
 * wallet signature signs anyone in (D3, WP7).
 */
export async function registerAuthRoutes(app: FastifyInstance, sql: postgres.Sql): Promise<void> {
  app.post("/api/v1/auth/logout", async (request) => {
    const token = extractBearerToken(request.headers.authorization);
    const revoked = token ? await revokeSessionToken(sql, token) : false;

    // Only a revocation that happened is recorded; a logout with a dead token changed nothing.
    const session = request.session;
    if (revoked && session && session.subjectId !== null) {
      await withActor(sql, { subjectId: session.subjectId }, (tx) =>
        recordAudit(tx, {
          session,
          effectiveRole: ROLE_SELF_BOUND,
          command: "auth.session.revoked",
          resourceType: "session",
          resourceId: session.sessionId,
          correlationId: request.context.correlationId,
          requestIp: request.clientIp,
        }),
      );
    }

    return { revoked, requestId: request.context.requestId };
  });

  app.get("/api/v1/auth/session", async (request) => {
    // Resolved by the request hook this request, so it is as fresh as any other check.
    if (!request.session) {
      return { authenticated: false, requestId: request.context.requestId };
    }
    const view = sessionView(request.session);
    if (request.headers["x-mpc-session-view"] === "workspace") {
      return {
        authenticated: true,
        ...view,
        workspaceAvailable: view.subjectId !== null,
        requestId: request.context.requestId,
      };
    }
    return { authenticated: true, ...view, requestId: request.context.requestId };
  });

  /**
   * The caller's own sessions (0126). The request hook already holds these to a second factor and
   * refuses a recovery-limited session; the database functions act only on sessions of the
   * caller session's subject, the authenticated actor, so no id in the request can reach anyone else's.
   */
  app.get("/api/v1/auth/sessions", async (request) => {
    const { session, actor } = requireOwnSessions(request);
    const rows = await ownSessions(sql, actor, (tx) =>
      tx<OwnSessionRow[]>`SELECT * FROM core.list_own_sessions(${session.sessionId})`,
    );
    return {
      items: rows.map((row) => ({
        id: row.session_id,
        firstFactor: row.first_factor,
        secondFactor: row.second_factor,
        createdAt: row.issued_at.toISOString(),
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        expiresAt: row.expires_at.toISOString(),
        current: row.is_current,
      })),
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });

  app.post<{ Params: { sessionId: string } }>("/api/v1/auth/sessions/:sessionId/revocation", async (request) => {
    const { session, actor } = requireOwnSessions(request);
    // A malformed id never gets here: `request-context.ts` answers 400 for any `...Id` that is
    // not a UUID.
    // Lower-cased: the id check and PostgreSQL both ignore case, so `current` and the audit row
    // must too (an upper-case spelling of this session's id is still this session).
    const target = request.params.sessionId.toLowerCase();

    return ownSessions(sql, actor, async (tx) => {
      const [row] = await tx<{ outcome: "revoked" | "already_ended" | "unknown" }[]>`
        SELECT core.revoke_own_session(${session.sessionId}, ${target}) AS outcome
      `;
      if (row!.outcome === "unknown") throw notFound("No such session on this account");
      const current = target === session.sessionId;
      if (row!.outcome === "revoked") {
        await recordAudit(tx, {
          session: { ...session, device: { userAgentHash: hashUserAgent(request.headers["user-agent"]) } },
          effectiveRole: ROLE_SELF_BOUND,
          command: "auth.session.revoked",
          resourceType: "session",
          resourceId: target,
          correlationId: request.context.correlationId,
          requestIp: request.clientIp,
          detail: { byHolder: true, current },
        });
      }
      return { id: target, revoked: row!.outcome === "revoked", current, requestId: request.context.requestId };
    });
  });
}

interface OwnSessionRow {
  session_id: string;
  first_factor: FirstFactor;
  second_factor: SecondFactor | null;
  issued_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
  is_current: boolean;
}

/** A person's own session. A service token never reaches these routes (no scope). */
function requireOwnSessions(request: FastifyRequest): { session: Session; actor: ActorContext } {
  const session = request.session;
  if (!session) throw unauthorized("UNAUTHENTICATED", "Authentication required");
  if (session.principal !== "person" || session.subjectId === null) {
    throw forbidden("ACCOUNT_SESSION_REQUIRED", "Only a person's account session has sessions to manage");
  }
  return { session, actor: { subjectId: session.subjectId } };
}

/** Runs as the caller; a session that ended mid-request reads as unauthenticated. */
async function ownSessions<T>(
  sql: postgres.Sql,
  actor: ActorContext,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  try {
    return await withActor(sql, actor, work);
  } catch (caught) {
    if (caught instanceof Error && caught.message.startsWith("MFA_SESSION_INVALID:")) {
      throw unauthorized("UNAUTHENTICATED", "The session is no longer valid");
    }
    throw caught;
  }
}
