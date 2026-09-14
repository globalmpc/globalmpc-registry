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
 * 로그인 경로의 상한 — 06 §6.9.
 *
 * 전역 상한보다 훨씬 좁다. 이 두 경로는 **인증 없이** 행을 만들거나 서명을
 * 검증한다. 정상적인 사람은 1분에 10번 로그인하지 않는다.
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
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
        issues: parsed.error.issues,
      });
    }

    // 서명할 체인은 서버 설정이 정한다. 요청의 값은 쓰지 않는다.
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
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다");
    }

    const session = await verifySiwe(
      sql,
      config,
      parsed.data.message,
      parsed.data.signature as `0x${string}`,
    );

    // SIWE 서명을 검증한 뒤에만 토큰을 발급한다. 토큰 원문은 여기서 한 번만
    // 클라이언트에 전달되며 서버는 해시만 저장한다.
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
    // 조직별 프로젝트 목록은 인가 내부 값이다. 화면에는 action 목록만 준다.
    const { organizationProjectIds: _internal, ...visible } = fresh;
    return {
      authenticated: true,
      ...visible,
      actions: Object.keys(ACTION_POLICIES).filter((action) => holdsActionRole(fresh, action)),
      requestId: request.context.requestId,
    };
  });
}
