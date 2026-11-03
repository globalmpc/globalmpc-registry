import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type postgres from "postgres";
import type { AppConfig } from "./config.js";
import { registerRequestContext } from "./plugins/request-context.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerSecurityHeaders } from "./plugins/security-headers.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerEmailAuthRoutes } from "./routes/email-auth.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerEmailChangeRoutes } from "./routes/email-change.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerProjectPartyRoutes } from "./routes/project-parties.js";
import { registerClaimDetailRoutes } from "./routes/claim-detail.js";
import { registerEvidenceLedgerRoutes } from "./routes/evidence-ledger.js";
import { registerCreReportRoutes } from "./routes/cre-reports.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerVerificationRoutes } from "./routes/verification.js";
import { registerReviewOptionRoutes } from "./routes/review-options.js";
import { registerReadinessRoutes } from "./routes/readiness.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerRoleRevocationRoutes } from "./routes/role-revocations.js";
import { registerMfaRoutes } from "./routes/mfa.js";
import { registerSubjectSuspensionRoutes } from "./routes/subject-suspensions.js";
import { registerOidcRoutes } from "./routes/oidc.js";
import type { OidcFetch } from "./services/oidc.js";
import { registerWalletRoutes } from "./routes/wallets.js";
import { registerBreakGlassRoutes } from "./routes/break-glass.js";
import { registerConnectionReviewRoutes } from "./routes/connection-review.js";
import { registerReviewRegistryRoutes } from "./routes/review-registry.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerLifecycleRoutes } from "./routes/lifecycle.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerGovernanceRoutes, type GovernanceChain } from "./routes/governance.js";
import { registerAuthorityRoutes } from "./routes/authorities.js";
import { registerSecondReviewRoute, registerSourceCollectRoutes } from "./routes/source-collect.js";
import type { SourceFetch } from "./services/source-fetch.js";
import { registerAuthorityAdminRoutes } from "./routes/authority-admin.js";
import { registerStaleSignalRoutes } from "./routes/stale-signals.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerDisclosureRestrictionRoutes } from "./routes/disclosure-restrictions.js";
import { registerSourceReconciliationRoutes } from "./routes/source-reconciliation.js";
import { registerBlockedAttemptRecorder } from "./restrictions.js";
import { registerDocumentStatusRoutes } from "./routes/document-status.js";
import { registerDocumentRevocationRoutes } from "./routes/document-revocation.js";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { createMetricsRegistry } from "./metrics.js";
import { createGovernanceChain } from "./governance-chain.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { createObjectStore } from "./object-store.js";
import { OIDC_PROVIDERS, ROUTES, toFastifyPath, type ServiceScope } from "@mpc/api-contract";
import { resolveServiceSession, resolveSession, type Session } from "./plugins/session.js";
import {
  extractBearerToken,
  isServiceToken,
  resolveServiceToken,
  resolveSessionToken,
} from "./plugins/session-token.js";
import { badRequest, forbidden, tooManyRequests } from "./errors.js";
import { isEncodedAuthPath } from "./plugins/path-encoding.js";

/** `METHOD /fastify/path` → the service scope that reaches it (contract `serviceScope`). */
const SERVICE_SCOPE_BY_ROUTE: ReadonlyMap<string, ServiceScope> = new Map(
  ROUTES.flatMap((route) =>
    route.serviceScope === undefined
      ? []
      : [[`${route.method.toUpperCase()} ${toFastifyPath(route.path)}`, route.serviceScope] as const],
  ),
);

/**
 * Unauthenticated routes (contract `public`). They never read a session, so a Bearer header on
 * them is not looked up: an attacker cannot make them cost a session query, and someone holding a
 * first-factor session can still ask for a new code instead of being told to finish MFA.
 */
const SESSIONLESS_ROUTES: ReadonlySet<string> = new Set(
  ROUTES.filter((route) => route.public).map(
    (route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`,
  ),
);

/** Routes a recovery-limited session may reach (contract `allowsRecoveryLimited`). */
const RECOVERY_LIMITED_ROUTES: ReadonlySet<string> = new Set(
  ROUTES.filter((route) => route.allowsRecoveryLimited === true).map(
    (route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`,
  ),
);

/**
 * Routes that check a first factor, by method, for `mpc_sign_in_failed_total` (alert
 * `MpcSignInFailureRate`).
 */
const SIGN_IN_ROUTES: ReadonlyMap<string, string> = new Map([
  ["/api/v1/auth/email/verify", "email_code"],
  ["/api/v1/auth/invitations/accept/verify", "invitation"],
]);

/**
 * The identity-provider callback (WP4) is one route for every provider; its method is the
 * provider. Only the known names become a label — a path segment never does, or any caller could
 * add series.
 */
const OIDC_SIGN_IN_ROUTE = "/api/v1/auth/oidc/:provider/callback";
const OIDC_SIGN_IN_METHODS: ReadonlySet<string> = new Set(OIDC_PROVIDERS);

function signInMethodOf(route: string, params: unknown): string | undefined {
  if (route === OIDC_SIGN_IN_ROUTE) {
    const provider = (params as { provider?: unknown } | undefined)?.provider;
    return typeof provider === "string" && OIDC_SIGN_IN_METHODS.has(provider) ? provider : "oidc_unknown";
  }
  return SIGN_IN_ROUTES.get(route);
}

/** Routes a first-factor-only session may reach (contract `allowsFirstFactorOnly`). */
const FIRST_FACTOR_ROUTES: ReadonlySet<string> = new Set(
  ROUTES.filter((route) => route.allowsFirstFactorOnly === true).map(
    (route) => `${route.method.toUpperCase()} ${toFastifyPath(route.path)}`,
  ),
);
import {
  createEdgeClientResolver,
  createOpsEndpointGuard,
  createProxyTrust,
  createUnroutableClientWarning,
} from "./client-ip.js";
import { registerStreamUploadCors } from "./plugins/stream-upload-cors.js";
import type { HostResolver } from "./services/source-endpoint.js";

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
    /**
     * The requester address every cap and audit row uses.
     *
     * Equals `request.ip` unless the edge proxy path is open (`EDGE_PROXY_SECRET`) and the
     * request carries a matching secret — then it is the address the web proxy saw.
     */
    clientIp: string;
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
  /**
   * How the API reaches Google and Microsoft (discovery, keys, token exchange). Tests run an
   * in-process provider here; unset, the global `fetch`.
   */
  readonly oidcFetch?: OidcFetch;
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
     * Sign-in failures likewise — a rising failure rate may be credential attempts rather than
     * typos. Counted per first-factor method (`SIGN_IN_ROUTES`), not only for wallet sign-in.
     */
    if (reply.statusCode === 429) {
      metrics.incrementCounter("mpc_rate_limited_total", { route });
    }
    const signInMethod = signInMethodOf(route, request.params);
    if (signInMethod !== undefined && reply.statusCode >= 400) {
      metrics.incrementCounter("mpc_sign_in_failed_total", {
        method: signInMethod,
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
  // Before any route: a blackout refusal from any route is kept in the history (AC-30).
  registerBlockedAttemptRecorder(app, sql);

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
   * The contract (`openapi.json`) states a separate cap on unauthenticated paths. The sign-in
   * routes create rows without auth (code challenges, login transactions) and carry a narrower
   * cap of their own (`AUTH_RATE_LIMIT_MAX`) on top of this one.
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

  /**
   * Resolved once per request, before the cap reads it. `request.ip` stays what fastify
   * decided from the socket and the trusted proxy ranges; `clientIp` adds the edge path.
   */
  const resolveEdgeClient = createEdgeClientResolver(config.edgeProxySecret);
  app.decorateRequest("clientIp", "");
  app.addHook("onRequest", async (request) => {
    request.clientIp = resolveEdgeClient(request.headers, request.ip);
  });

  /**
   * Defence in depth for the web BFF (WP6). The web proxy recognises the routes that issue or end
   * a session by their literal path and turns the token into a cookie; this router decodes
   * percent-encoding, so `/api/v1/auth/email/%76erify` would reach the same route past that
   * recognition and hand the token to page script. No auth route takes a value that needs
   * encoding (ids are UUIDs or base64url), so an encoded auth path is refused outright.
   */
  app.addHook("onRequest", async (request) => {
    if (isEncodedAuthPath(request.raw.url ?? "")) {
      throw badRequest("PATH_ENCODING_REFUSED", "Percent-encoded authentication paths are not accepted");
    }
  });

  /**
   * Public and authenticated routes count in separate pools (07 §7.1). The pool is chosen by
   * the matched route, which is known before any session lookup.
   */
  const isPublicRoute = (request: FastifyRequest) =>
    request.routeOptions.url?.startsWith("/api/v1/public/") === true;

  await app.register(rateLimit, {
    global: true,
    max: (request) => (isPublicRoute(request) ? config.publicRateLimitMax : config.rateLimitMax),
    timeWindow: "1 minute",
    /**
     * An unverified Bearer value is not an identity. Only the IP determined through the trusted
     * proxy boundary is used here. This hook runs before the session DB lookup, so requests
     * over the cap never reach `core.resolve_session_token`.
     */
    keyGenerator: (request) => {
      // Report the first moment the cap key falls to a private address. That state runs without
      // errors, so unless the server says so, nobody in deployment notices.
      warnUnroutableClient(request.clientIp);
      return isPublicRoute(request) ? `public:${request.clientIp}` : request.clientIp;
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
   * by the account sign-in flows, and the server does not store raw tokens (hash only).
   *
   * The dev wallet header path was removed in R1. An address in the header is treated as a
   * token, fails lookup, and yields 401 — there is no silent pass-through path.
   */
  app.addHook("preParsing", async (request) => {
    // These routes do not consume a session. Keeps an attacker from triggering session DB
    // lookups by attaching meaningless Bearer headers.
    const route = request.routeOptions.url;
    if (
      route?.startsWith("/api/v1/public/") === true ||
      (route !== undefined && SESSIONLESS_ROUTES.has(`${request.method} ${route}`))
    ) {
      return;
    }

    const token = extractBearerToken(request.headers.authorization);
    if (!token) return;

    if (isServiceToken(token)) {
      const service = await resolveServiceToken(sql, token);
      if (!service) return;
      /**
       * A service token reaches only the routes its scopes name — D7. A route without a scope
       * is a person route and refuses every service token, whatever roles the service subject
       * holds; checked here, before the route runs, so no route has to remember it.
       */
      const scope = route === undefined ? undefined : SERVICE_SCOPE_BY_ROUTE.get(`${request.method} ${route}`);
      if (scope === undefined) {
        throw forbidden("SERVICE_TOKEN_ROUTE_DENIED", "A service token cannot call this route");
      }
      if (!service.scopes.includes(scope)) {
        throw forbidden("SERVICE_TOKEN_SCOPE_DENIED", "This service token is not scoped for this route", {
          requiredScope: scope,
        });
      }
      request.session = await resolveServiceSession(sql, service);
      return;
    }

    const resolved = await resolveSessionToken(sql, token);
    if (!resolved) return;

    const session = await resolveSession(sql, resolved);

    /**
     * Priority rule 2: a first-factor-only session reaches MFA enrolment, MFA challenge, logout
     * and its own session — nothing else, not even reads. The routes that allow it say so in the
     * contract (`allowsFirstFactorOnly`); every other route refuses it here.
     */
    if (
      session.aal === "aal1" &&
      (route === undefined || !FIRST_FACTOR_ROUTES.has(`${request.method} ${route}`))
    ) {
      throw forbidden("MFA_REQUIRED", "Complete a second factor before using this session", {
        reason: "AUTHENTICATION_LEVEL_INSUFFICIENT",
        requiredAal: "aal2",
      });
    }

    /**
     * A session restored by a recovery code may only enrol a new factor, read its own session
     * and sign out (WP3) — the same allowlist pattern as rule 2.
     */
    if (
      session.recoveryLimited &&
      (route === undefined || !RECOVERY_LIMITED_ROUTES.has(`${request.method} ${route}`))
    ) {
      throw forbidden(
        "MFA_RECOVERY_REENROLMENT_REQUIRED",
        "Enrol a new passkey or authenticator app before using this session",
        { reason: "RECOVERY_CODE_SESSION" },
      );
    }

    request.session = session;
  });

  /**
   * The object store is **one shared instance**.
   *
   * If upload and evidence finalization each built their own, the `memory` setup would see
   * different stores — the finalize path could not find uploaded files.
   */
  const objectStore = createObjectStore(config);

  await registerHealthRoutes(app, sql, metrics, createOpsEndpointGuard(config.opsEndpointCidrs));
  await registerAuthRoutes(app, sql);
  await registerEmailAuthRoutes(app, sql, config);
  await registerInvitationRoutes(app, sql, config);
  await registerEmailChangeRoutes(app, sql, config);
  await registerMfaRoutes(app, sql, config);
  await registerSubjectSuspensionRoutes(app, sql);
  await registerOidcRoutes(app, sql, config, deps.oidcFetch);
  await registerWalletRoutes(app, sql, config);
  await registerProjectRoutes(app, sql);
  await registerProjectPartyRoutes(app, sql);
  await registerClaimDetailRoutes(app, sql);
  await registerEvidenceLedgerRoutes(app, sql);
  await registerCreReportRoutes(app, sql, config);
  await registerEvidenceRoutes(app, sql, objectStore);
  await registerVerificationRoutes(app, sql, config);
  await registerReviewOptionRoutes(app, sql);
  await registerReadinessRoutes(app, sql, config);
  await registerRegistryRoutes(app, sql, config);
  await registerPublicRoutes(app, sql, config);
  await registerAdminRoutes(app, sql);
  await registerRoleRevocationRoutes(app, sql);
  await registerBreakGlassRoutes(app, sql);
  await registerConnectionReviewRoutes(app, sql);
  await registerReviewRegistryRoutes(app, sql);
  await registerWorkspaceRoutes(app, sql);
  await registerLifecycleRoutes(app, sql);
  await registerObservabilityRoutes(app, sql);
  await registerExportRoutes(app, sql);
  await registerGovernanceRoutes(app, sql, governanceChain);
  await registerAuthorityRoutes(app, sql);
  await registerSourceCollectRoutes(app, sql, deps.fetchImpl, deps.resolveHost);
  await registerAuthorityAdminRoutes(app, sql);
  await registerSecondReviewRoute(app, sql);
  await registerStaleSignalRoutes(app, sql);
  await registerDocumentRoutes(app, sql);
  await registerDisclosureRestrictionRoutes(app, sql);
  await registerSourceReconciliationRoutes(app, sql);
  await registerDocumentStatusRoutes(app, sql);
  await registerDocumentRevocationRoutes(app, sql);
  // multipart is used only by the upload route. It is registered globally, but only one route
  // reads file parts, so body parsing for other routes is unaffected.
  await app.register(multipart);
  // The one route a browser may call across origins, and only when the deployment names that
  // origin. Registered before the route so the preflight never reaches multipart parsing.
  await registerStreamUploadCors(app, config.edgeWebOrigin);
  // One store per server. Building one per route multiplies connections.
  await registerUploadRoutes(app, sql, objectStore);

  return app;
}
