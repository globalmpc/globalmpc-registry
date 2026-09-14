import Fastify, { type FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { AppConfig } from "./config.js";
import { registerRequestContext } from "./plugins/request-context.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerSecurityHeaders } from "./plugins/security-headers.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerVerificationRoutes } from "./routes/verification.js";
import { registerReadinessRoutes } from "./routes/readiness.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerGovernanceRoutes, type GovernanceChain } from "./routes/governance.js";
import { registerAuthorityRoutes } from "./routes/authorities.js";
import { registerSecondReviewRoute, registerSourceCollectRoutes } from "./routes/source-collect.js";
import type { SourceFetch } from "./services/source-fetch.js";
import { registerAuthorityAdminRoutes } from "./routes/authority-admin.js";
import { registerStaleSignalRoutes } from "./routes/stale-signals.js";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { createMetricsRegistry } from "./metrics.js";
import { createGovernanceChain } from "./governance-chain.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { createObjectStore } from "./object-store.js";
import { resolveSession, type Session } from "./plugins/session.js";
import { extractBearerToken, resolveSessionToken } from "./plugins/session-token.js";
import { tooManyRequests } from "./errors.js";
import { createProxyTrust, createUnroutableClientWarning } from "./client-ip.js";
import type { HostResolver } from "./services/source-endpoint.js";

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyInstance {
    /** 실제로 등록된 라우트. 계약↔구현 대조와 운영 디버깅에 쓴다. */
    registeredRoutes: { method: string; url: string }[];
  }
}

/**
 * 외부에서 주입하는 것.
 *
 * 출처 조회는 실제 기관으로 나가는 요청이다. 테스트가 진짜 등록부를 부르면
 * 되지 않으므로 호출자를 바꿔 끼운다.
 */
export interface ServerDeps {
  readonly fetchImpl?: SourceFetch;
  /**
   * 이름을 주소로 푸는 함수.
   *
   * 출처를 부르기 직전에 대상이 사설 주소로 해석되지 않는지 본다(SSRF).
   * 테스트는 실제 DNS를 쓰지 않으므로 여기서 바꿔 낀다.
   */
  readonly resolveHost?: HostResolver;
  /**
   * 거버넌스 스냅숏용 체인 접근.
   *
   * 토큰 컨트랙트가 아직 없으므로(R4 이전) 테스트가 진짜 체인을 부를 수 없다.
   * 주지 않으면 설정에서 만든다.
   */
  readonly governanceChain?: GovernanceChain;
}

export async function buildServer(
  config: AppConfig,
  sql: postgres.Sql,
  deps: ServerDeps = {},
): Promise<FastifyInstance> {
  /**
   * 요청자 판정 — 프록시 뒤라는 사실을 서버가 알아야 한다.
   *
   * 배포에서 브라우저는 `web`의 `/api/*`를 지나 여기 닿는다. 소켓 주소는 언제나
   * web 컨테이너이므로, 그것을 요청자로 보면 상한·로그·감사가 전부 한 주소로
   * 뭉친다.
   *
   * `true`를 주지 않는다. 그러면 헤더의 **맨 왼쪽**을 믿게 되고, 그 값은 요청자가
   * 직접 채울 수 있다 — 상한이 우회 가능해진다.
   *
   * 홉 수만 주던 것도 더는 쓰지 않는다. fastify 5.12.1이 그 형태를 없앴고 이유가
   * 정확하다 — **홉 수는 바로 앞 상대가 누구인지 검사하지 않는다.** 프록시를
   * 거치지 않고 직접 닿은 요청이 헤더를 스스로 채우면 그대로 요청자가 된다.
   * 홉 수와 피어 대역을 **둘 다** 요구한다(`createProxyTrust`).
   */
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    trustProxy: createProxyTrust(config.trustedProxyHops, config.trustedProxyCidrs),
    /**
     * 시간 상한.
     *
     * Fastify는 둘 다 **끈 채로** 만든다. 실측에서 `requestTimeout`도
     * `server.timeout`도 0이었고, 걸려 있는 것은 `headersTimeout` 60초와
     * `bodyLimit` 1MiB뿐이었다. 헤더만 제때 보내면 그 뒤로는 시간을 쓰지 않는
     * 연결이 무한히 남는다 — 인터넷에서 도달하는 표면이다.
     *
     * 둘은 서로 다른 것을 막는다. `requestTimeout`은 요청 하나의 총시간,
     * `connectionTimeout`은 아무것도 보내지 않는 소켓이다. 후자는 전송 중에
     * 갱신되므로 2GiB 스트리밍 업로드를 자르지 않는다.
     */
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.socketIdleTimeoutMs,
  });

  /**
   * 메트릭 수집.
   *
   * 경로는 route 템플릿으로 정규화한다 — URL을 그대로 쓰면 UUID마다 시계열이
   * 생겨 수집기가 죽는다.
   */
  /**
   * 거버넌스 스냅숏용 체인 접근.
   *
   * `GOVERNANCE_TOKEN_ADDRESS`가 없으면 스냅숏을 만들지 않고 수동 무게로
   * 떨어진다 — 토큰이 배포되기 전에는 읽을 잔고가 없다. 그 사실은 응답의
   * `weightSource`가 밝힌다.
   */
  const governanceChain = deps.governanceChain ?? createGovernanceChain(config);

  const metrics = createMetricsRegistry();
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    // 운영 endpoint 자신은 세지 않는다. 수집 주기가 곧 트래픽으로 보인다.
    if (route.startsWith("/health") || route === "/metrics") return;
    metrics.observeRequest(request.method, route, reply.statusCode, reply.elapsedTime);

    /**
     * 알림이 필요한 둘을 따로 센다.
     *
     * `http_requests_total`의 `status`는 `4xx`로 뭉쳐 있다. 그 상태로는 "상한에
     * 걸리고 있다"와 "잘못된 요청이 많다"가 구분되지 않고, 둘은 대응이 다르다.
     * SIWE 실패도 마찬가지다 — 로그인 실패율이 오르는 것은 오타가 아니라
     * 자격증명 시도일 수 있다.
     */
    if (reply.statusCode === 429) {
      metrics.incrementCounter("mpc_rate_limited_total", { route });
    }
    if (route === "/api/v1/auth/siwe/verify" && reply.statusCode >= 400) {
      metrics.incrementCounter("mpc_siwe_verify_failed_total", {
        status: String(reply.statusCode),
      });
    }
  });

  /**
   * 등록된 라우트를 수집한다.
   *
   * `@mpc/api-contract`의 `ROUTES`는 계약이고 여기 등록되는 것은 구현이다. 둘이
   * 갈라지는 것을 사람이 눈으로 잡을 수 없으므로 목록을 노출해 테스트가 대조한다.
   * 훅은 라우트 등록보다 먼저 걸어야 한다.
   */
  const registeredRoutes: { method: string; url: string }[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      registeredRoutes.push({ method: method.toUpperCase(), url: route.url });
    }
  });

  await registerRequestContext(app);
  await registerErrorHandler(app);

  /**
   * 보안 응답 헤더 — 10 §10.6.
   *
   * 상한보다 **먼저** 건다. 429도 브라우저가 받는 응답이므로 같은 헤더가 붙어야
   * 한다.
   */
  await registerSecurityHeaders(app, { production: config.nodeEnv === "production" });

  /**
   * 요청 상한 — 06 §6.9, 07 §7.1.
   *
   * 계약(`openapi.json`)은 무인증 경로에 별도 상한이 있다고 밝히지만 구현이
   * 없었다. 특히 `/auth/siwe/nonce`는 인증 없이 행을 만드는 경로다 — 상한이
   * 없으면 아무나 `core.siwe_nonces`를 채울 수 있다.
   *
   * 키는 **검증 전 헤더가 아니라 요청자 IP**다. `Authorization`에 들어온 값을
   * 그대로 키로 쓰면 공격자가 가짜 Bearer 값을 요청마다 바꿔 새 몫을 얻는다.
   * 실제 세션인지 확인하려면 DB를 읽어야 하는데, 그 조회보다 상한이 먼저 실행돼야
   * DB 자체를 보호할 수 있다. 따라서 이 첫 방어선은 IP 기준이어야 한다.
   *
   * **이것은 프로세스 안의 상한이다.** 복제본이 늘면 그만큼 총량이 늘어난다.
   * 경계에서의 상한(프록시·WAF)을 대신하지 않는다.
   */
  /**
   * 홉 수 설정이 틀렸다는 것을 서버가 스스로 말하게 한다.
   *
   * `TRUSTED_PROXY_HOPS`가 맞는지는 코드가 알 수 없다 — 프록시 수는 배포 환경의
   * 사실이다. 다만 **작게 잡혔을 때의 증상**은 여기서 보인다: 요청자가 컨테이너의
   * 사설 주소로 판정된다. 크게 잡힌 경우(요청자가 헤더로 주소를 꾸미는 것)는
   * 꾸민 주소도 공인 주소라 여기서 잡히지 않는다 — 그쪽은 배포 뒤 실제 프록시
   * 홉 수를 확인하는 운영 절차가 맡는다.
   */
  const warnUnroutableClient = createUnroutableClientWarning((address, message) =>
    app.log.warn({ clientAddress: address, trustedProxyHops: config.trustedProxyHops }, message),
  );

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: "1 minute",
    /**
     * 검증 전 Bearer 값은 identity가 아니다. 여기서는 신뢰 프록시 경계를 통과해
     * 판정한 IP만 쓴다. 이 hook은 세션 DB 조회보다 먼저 실행되므로, 상한을 넘은
     * 요청은 `core.resolve_session_token`에도 닿지 않는다.
     */
    keyGenerator: (request) => {
      // 상한 키가 사설 주소로 떨어지는 첫 순간에 알린다. 그 상태는 오류 없이
      // 동작하므로, 서버가 말하지 않으면 배포에서 아무도 알아채지 못한다.
      warnUnroutableClient(request.ip);
      return request.ip;
    },
    // 운영 endpoint는 세지 않는다. 수집 주기가 곧 상한을 먹는다.
    allowList: (request) =>
      request.url.startsWith("/health") || request.url === "/metrics",
    /**
     * 상한 초과도 07 §7.1의 envelope으로 나간다.
     *
     * 여기서 본문을 만들지 않고 `AppError`를 던져 error handler가 만들게 한다 —
     * envelope을 만드는 곳이 둘이면 한쪽만 형식이 바뀐다.
     */
    errorResponseBuilder: (_request, context) => {
      throw tooManyRequests("RATE_LIMITED", "요청이 너무 잦다. 잠시 뒤 다시 시도한다", {
        limit: String(context.max),
        retryAfterSeconds: String(Math.ceil(context.ttl / 1000)),
      });
    },
  });

  app.decorateRequest("session", null);

  /**
   * 세션 해석.
   *
   * Authorization 헤더의 Bearer 토큰으로 세션을 찾는다. 토큰은 SIWE 서명을
   * 검증한 뒤에만 발급되며, 서버는 토큰 원문을 저장하지 않는다(해시만 저장).
   *
   * 개발용 wallet 헤더 경로는 R1에서 제거됐다. 주소를 헤더에 넣어도 토큰으로
   * 취급되어 조회에 실패하고 401이 된다 — 조용히 통과하는 경로가 없다.
   */
  app.addHook("preParsing", async (request) => {
    // 이 route들은 세션을 소비하지 않는다. 공격자가 무의미한 Bearer 헤더를 붙여
    // 세션 DB 조회를 만들지 못하게 한다.
    const route = request.routeOptions.url;
    if (
      route === "/api/v1/auth/siwe/nonce" ||
      route === "/api/v1/auth/siwe/verify" ||
      route?.startsWith("/api/v1/public/") === true
    ) {
      return;
    }

    const token = extractBearerToken(request.headers.authorization);
    if (!token) return;

    const resolved = await resolveSessionToken(sql, token);
    if (!resolved) return;

    request.session = await resolveSession(sql, resolved.walletAddress, resolved.chainId);
  });

  /**
   * 객체 저장소는 **한 인스턴스**를 나눠 쓴다.
   *
   * 업로드와 증빙 확정이 각각 만들면 `memory` 구성에서 서로 다른 저장소를
   * 보게 된다 — 올린 파일을 확정 경로가 찾지 못한다.
   */
  const objectStore = createObjectStore(config);

  await registerHealthRoutes(app, sql, metrics);
  await registerAuthRoutes(app, sql, config);
  await registerProjectRoutes(app, sql);
  await registerEvidenceRoutes(app, sql, objectStore);
  await registerVerificationRoutes(app, sql, config);
  await registerReadinessRoutes(app, sql);
  await registerRegistryRoutes(app, sql, config);
  await registerPublicRoutes(app, sql, config);
  await registerAdminRoutes(app, sql);
  await registerWorkspaceRoutes(app, sql);
  await registerLifecycleRoutes(app, sql);
  await registerObservabilityRoutes(app, sql);
  await registerGovernanceRoutes(app, sql, governanceChain);
  await registerAuthorityRoutes(app, sql);
  await registerSourceCollectRoutes(app, sql, deps.fetchImpl, deps.resolveHost);
  await registerAuthorityAdminRoutes(app, sql);
  await registerSecondReviewRoute(app, sql);
  await registerStaleSignalRoutes(app, sql);
  // multipart는 업로드 route에서만 쓴다. 전역 등록이지만 파일 파트를 읽는
  // route가 하나뿐이라 다른 route의 body 파싱에는 영향이 없다.
  await app.register(multipart);
  // 저장소는 서버당 하나다. route마다 만들면 연결이 그만큼 늘어난다.
  await registerUploadRoutes(app, sql, objectStore);

  return app;
}
