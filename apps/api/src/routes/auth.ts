import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { ACTION_POLICIES, siweNonceRequest, siweVerifyRequest } from "@mpc/api-contract";
import { holdsActionRole } from "../plugins/authorize.js";
import type { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { SIWE_STATEMENT, issueNonce, resolveSession, verifySiwe } from "../plugins/session.js";
import {
  extractBearerToken,
  issueSessionToken,
  revokeSessionToken,
} from "../plugins/session-token.js";

/**
 * Rate cap for the login routes — 06 §6.9.
 *
 * Much tighter than the global cap. These two routes create rows or verify signatures
 * **without authentication**. A legitimate user does not log in 10 times a minute.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  config: AppConfig,
): Promise<void> {
  const authRateLimit = {
    rateLimit: { max: config.authRateLimitMax, timeWindow: "1 minute" },
  };

  app.post("/api/v1/auth/siwe/nonce", { config: authRateLimit }, async (request) => {
    const parsed = siweNonceRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    // Server config decides the chain to sign for. The request value is not used.
    const { nonce, expiresAt } = await issueNonce(
      sql,
      parsed.data.walletAddress,
      config.chainId,
    );

    return {
      nonce,
      expiresAt,
      domain: config.siweDomain,
      uri: config.siweUri,
      chainId: config.chainId,
      statement: SIWE_STATEMENT,
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });

  app.post("/api/v1/auth/siwe/verify", { config: authRateLimit }, async (request) => {
    const parsed = siweVerifyRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid");
    }

    const session = await verifySiwe(
      sql,
      config,
      parsed.data.message,
      parsed.data.signature as `0x${string}`,
    );

    // A token is issued only after the SIWE signature is verified. The raw token reaches the
    // client only here, once; the server stores only its hash.
    const issued = await issueSessionToken(sql, session.walletAddress, session.chainId);

    return {
      ...session,
      sessionToken: issued.token,
      verifiedWalletAddress: session.walletAddress,
      expiresAt: issued.expiresAt,
      credentials: [],
      mfaSatisfied: false,
      organizationIds: [],
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });

  app.post("/api/v1/auth/logout", async (request) => {
    const token = extractBearerToken(request.headers.authorization);
    const revoked = token ? await revokeSessionToken(sql, token) : false;
    return { revoked, requestId: request.context.requestId };
  });

  app.get("/api/v1/auth/session", async (request) => {
    if (!request.session) {
      return { authenticated: false, requestId: request.context.requestId };
    }
    const fresh = await resolveSession(sql, request.session.walletAddress, config.chainId);
    // Per-organization project lists are authorization internals. Screens get only the action list.
    const { organizationProjectIds: _internal, ...visible } = fresh;
    return {
      authenticated: true,
      ...visible,
      actions: Object.keys(ACTION_POLICIES).filter((action) => holdsActionRole(fresh, action)),
      requestId: request.context.requestId,
    };
  });
}
