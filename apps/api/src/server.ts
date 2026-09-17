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
import { registerReviewOptionRoutes } from "./routes/review-options.js";
import { registerReadinessRoutes } from "./routes/readiness.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerRoleRevocationRoutes } from "./routes/role-revocations.js";
import { registerReviewRegistryRoutes } from "./routes/review-registry.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerGovernanceRoutes, type GovernanceChain } from "./routes/governance.js";
import { registerAuthorityRoutes } from "./routes/authorities.js";
import { registerSecondReviewRoute, registerSourceCollectRoutes } from "./routes/source-collect.js";
import type { SourceFetch } from "./services/source-fetch.js";
import { registerAuthorityAdminRoutes } from "./routes/authority-admin.js";
import { registerStaleSignalRoutes } from "./routes/stale-signals.js";
import { registerDocumentRoutes } from "./routes/documents.js";
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
    /** Routes actually registered. Used for contract↔implementation comparison and ops debugging. */
    registeredRoutes: { method: string; url: string }[];
  }
}

/**
 * What is injected from outside.
 *
 * Source lookup sends requests to real authorities. Tests must not call a real registry, so
 * the caller is swappable.
 */
export interface ServerDeps {
  readonly fetchImpl?: SourceFetch;
  /**
   * Resolves a name to addresses.
   *
   * Checks right before calling a source that the target does not resolve to a private address
   * (SSRF). Tests do not use real DNS, so it is swapped here.
   */
  readonly resolveHost?: HostResolver;
  /**
   * Chain access for governance snapshots.
   *
   * The token contract does not exist yet (pre-R4), so tests cannot call a real chain.
   * Built from config when not provided.
   */
  readonly governanceChain?: GovernanceChain;
}

export async function buildServer(
  config: AppConfig,
  sql: postgres.Sql,
  deps: ServerDeps = {},
): Promise<FastifyInstance> {
  /**
   * Requester determination — the server must know it sits behind a proxy.
   *
   * In deployment the browser reaches here through `web`'s `/api/*`. The socket address is
   * always the web container, so treating it as the requester collapses caps, logs, and audit
   * onto a single address.
   *
   * Never pass `true`. That trusts the **leftmost** header entry, which the requester can fill
   * directly — making the cap bypassable.
   *
   * Passing only a hop count is no longer used either. fastify 5.12.1 removed that form, for a
   * precise reason — **a hop count does not check who the immediate peer is.** A request that
   * bypasses the proxy and fills the header itself becomes the requester as is.
   * **Both** a hop count and a peer range are required (`createProxyTrust`).
   */
  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "info" },
    trustProxy: createProxyTrust(config.trustedProxyHops, config.trustedProxyCidrs),
    /**
     * Time caps.
     *
     * Fastify builds both **turned off**. Measured: `requestTimeout` and
     * `server.timeout` were both 0; only `headersTimeout` 60 s and
     * `bodyLimit` 1 MiB applied. A client that sends headers on time can then hold the
     * connection open indefinitely — on a surface reachable from the internet.
     *
     * The two block different things. `requestTimeout` is one request's total time;
     * `connectionTimeout` is a socket that sends nothing. The latter is refreshed during transfer,
     * so it does not cut 2 GiB streaming uploads.
     */
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.socketIdleTimeoutMs,
  });

  /**
   * Metrics collection.
   *
   * Paths are normalized to route templates — raw URLs create a series per UUID and kill
   * the collector.
   */
  /**
   * Chain access for governance snapshots.
   *
   * Without `GOVERNANCE_TOKEN_ADDRESS` no snapshot is taken and weight falls back to
   * manual — before the token is deployed there is no balance to read. The response's
   * `weightSource` discloses that.
   */
  const governanceChain = deps.governanceChain ?? createGovernanceChain(config);

  const metrics = createMetricsRegistry();
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    // Do not count the ops endpoint itself. The scrape interval would show up as traffic.
    if (route.startsWith("/health") || route === "/metrics") return;
    metrics.observeRequest(request.method, route, reply.statusCode, reply.elapsedTime);

    /**
     * Counts separately the two that need alerts.
     *
     * `status` in `http_requests_total` is bucketed as `4xx`. In that form "hitting the cap" and
     * "many bad requests" are indistinguishable, and they need different responses.
     * SIWE failures likewise — a rising login failure rate may be credential attempts rather
     * than typos.
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
   * Collects registered routes.
   *
   * `ROUTES` in `@mpc/api-contract` is the contract; what registers here is the implementation.
   * Humans cannot catch the two diverging by eye, so the list is exposed for tests to compare.
   * The hook must be attached before route registration.
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
   * Security response headers — 10 §10.6.
   *
   * Attached **before** the cap. A 429 is also a response the browser receives, so it needs the
   * same headers.
   */
  await registerSecurityHeaders(app, { production: config.nodeEnv === "production" });

  /**
   * Request cap — 06 §6.9, 07 §7.1.
   *
   * The contract (`openapi.json`) states a separate cap on unauthenticated paths, but there was
   * no implementation. `/auth/siwe/nonce` in particular creates rows without auth — without a
   * cap anyone could fill `core.siwe_nonces`.
   *
   * The key is **the requester IP, not an unverified header**. Using the `Authorization` value
   * as the key lets an attacker get a fresh share per request by rotating a fake Bearer value.
   * Checking for a real session requires a DB read, and the cap must run before that lookup to
   * protect the DB itself. So this first line of defense must be IP-based.
   *
   * **This is an in-process cap.** More replicas raise the total accordingly.
   * It does not replace a cap at the edge (proxy, WAF).
   */
  /**
   * Lets the server itself report a wrong hop-count setting.
   *
   * Code cannot know whether `TRUSTED_PROXY_HOPS` is right — the proxy count is a fact of the
   * deployment. But **the symptom of setting it too low** shows here: the requester resolves to
   * a container's private address. Setting it too high (the requester forging an address via
   * the header) is not caught here since the forged address is also public — that is left to
   * the ops procedure that checks the real proxy hop count after deployment.
   */
  const warnUnroutableClient = createUnroutableClientWarning((address, message) =>
    app.log.warn({ clientAddress: address, trustedProxyHops: config.trustedProxyHops }, message),
  );

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: "1 minute",
    /**
     * An unverified Bearer value is not an identity. Only the IP determined through the trusted
     * proxy boundary is used here. This hook runs before the session DB lookup, so requests
     * over the cap never reach `core.resolve_session_token`.
     */
    keyGenerator: (request) => {
      // Report the first moment the cap key falls to a private address. That state runs without
      // errors, so unless the server says so, nobody in deployment notices.
      warnUnroutableClient(request.ip);
      return request.ip;
    },
    // Do not count the ops endpoint. The scrape interval would eat the cap.
    allowList: (request) =>
      request.url.startsWith("/health") || request.url === "/metrics",
    /**
     * Cap overruns also go out as the 07 §7.1 envelope.
     *
     * Do not build the body here; throw `AppError` and let the error handler build it —
     * with two places building envelopes, only one of them changes format.
     */
    errorResponseBuilder: (_request, context) => {
      throw tooManyRequests("RATE_LIMITED", "Too many requests. Try again shortly", {
        limit: String(context.max),
        retryAfterSeconds: String(Math.ceil(context.ttl / 1000)),
      });
    },
  });

  app.decorateRequest("session", null);

  /**
   * Session resolution.
   *
   * Finds the session from the Bearer token in the Authorization header. Tokens are issued only
   * after verifying the SIWE signature, and the server does not store raw tokens (hash only).
   *
   * The dev wallet header path was removed in R1. An address in the header is treated as a
   * token, fails lookup, and yields 401 — there is no silent pass-through path.
   */
  app.addHook("preParsing", async (request) => {
    // These routes do not consume a session. Keeps an attacker from triggering session DB
    // lookups by attaching meaningless Bearer headers.
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
   * The object store is **one shared instance**.
   *
   * If upload and evidence finalization each built their own, the `memory` setup would see
   * different stores — the finalize path could not find uploaded files.
   */
  const objectStore = createObjectStore(config);

  await registerHealthRoutes(app, sql, metrics);
  await registerAuthRoutes(app, sql, config);
  await registerProjectRoutes(app, sql);
  await registerEvidenceRoutes(app, sql, objectStore);
  await registerVerificationRoutes(app, sql, config);
  await registerReviewOptionRoutes(app, sql);
  await registerReadinessRoutes(app, sql);
  await registerRegistryRoutes(app, sql, config);
  await registerPublicRoutes(app, sql, config);
  await registerAdminRoutes(app, sql);
  await registerRoleRevocationRoutes(app, sql);
  await registerReviewRegistryRoutes(app, sql);
  await registerWorkspaceRoutes(app, sql);
  await registerLifecycleRoutes(app, sql);
  await registerObservabilityRoutes(app, sql);
  await registerGovernanceRoutes(app, sql, governanceChain);
  await registerAuthorityRoutes(app, sql);
  await registerSourceCollectRoutes(app, sql, deps.fetchImpl, deps.resolveHost);
  await registerAuthorityAdminRoutes(app, sql);
  await registerSecondReviewRoute(app, sql);
  await registerStaleSignalRoutes(app, sql);
  await registerDocumentRoutes(app, sql);
  // multipart is used only by the upload route. It is registered globally, but only one route
  // reads file parts, so body parsing for other routes is unaffected.
  await app.register(multipart);
  // One store per server. Building one per route multiplies connections.
  await registerUploadRoutes(app, sql, objectStore);

  return app;
}
