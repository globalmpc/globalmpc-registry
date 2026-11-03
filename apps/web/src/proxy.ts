import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  cookieMode,
  cookieOptions,
  crossSiteRefusal,
  pathRefusal,
  decodeOidcBinding,
  encodeOidcBinding,
  OIDC_MAX_AGE,
  oidcRoute,
  SESSION_ISSUING_ROUTES,
  sessionEndingRoute,
  type SessionEnding,
  sessionMaxAge,
  withoutCredentials,
  type CookieMode,
  type OidcPurpose,
} from "./lib/bff";

/** Header carrying the shared secret to the API. Mirrors the API's `EDGE_SECRET_HEADER`. */
const EDGE_SECRET_HEADER = "x-mpc-edge-secret";
/** Header carrying the visitor address this proxy saw. Mirrors the API's `EDGE_CLIENT_IP_HEADER`. */
const EDGE_CLIENT_IP_HEADER = "x-mpc-client-ip";

/**
 * The visitor address as the platform in front of this proxy reports it.
 *
 * On a CDN the platform sets `x-real-ip`; elsewhere the last `x-forwarded-for` entry is the
 * closest thing available. It is the last, not the first, for the reason `TRUSTED_PROXY_HOPS`
 * reads from the right on the API: a platform that appends leaves whatever the visitor sent on
 * the left, and vouching for that would give every forged address its own sign-in cap.
 * Neither value is verified here — the API only uses it together with the secret, i.e. when it
 * is certain the value came from this code and not from the visitor. That is only as good as the
 * platform: it must overwrite both headers (Vercel does). One that passes a visitor's own
 * `x-real-ip` through lets the visitor choose the address vouched for — docs/operations/deployment.md says so.
 */
function visitorAddress(request: NextRequest): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return forwarded ? forwarded : null;
}

/**
 * Request headers forwarded to the API.
 *
 * The two edge headers are always stripped from what the visitor sent — a visitor must not be
 * able to name its own address — and re-added only when this deployment holds the secret.
 */
export function edgeRequestHeaders(request: NextRequest, secret: string | undefined): Headers {
  const headers = new Headers(request.headers);
  headers.delete(EDGE_SECRET_HEADER);
  headers.delete(EDGE_CLIENT_IP_HEADER);

  if (!secret) return headers;
  const address = visitorAddress(request);
  if (!address) return headers;

  headers.set(EDGE_SECRET_HEADER, secret);
  headers.set(EDGE_CLIENT_IP_HEADER, address);
  return headers;
}

/**
 * Proxies `/api/*` to the API server as same-origin, and holds the browser's session (WP6).
 *
 * Why a proxy instead of opening CORS: browser requests stay same-origin, so the session cookie
 * never has to cross an origin. CORS plus cross-origin cookies turns a configuration slip into an
 * auth bypass.
 *
 * **This lives here, not in `rewrites()` of `next.config.ts`, for a reason.** `rewrites()` is
 * evaluated at build time and the destination string is baked into `routes-manifest.json`. The
 * API address is unknown when the image is built, so the default `http://localhost:3001` gets
 * baked in and the `API_ORIGIN` given at run time is ignored — inside a container localhost is
 * the container itself, and every API call has nowhere to go. The proxy runs per request, so
 * it reads the environment at that moment.
 *
 * When the web app runs on a CDN whose egress addresses are not fixed, the API cannot trust
 * `x-forwarded-for` from it. `EDGE_PROXY_SECRET` (the same value on both sides) lets this proxy
 * vouch for the visitor address it saw. Without it the API falls back to the socket address —
 * one shared requester for the whole site — and says so in its log.
 *
 * **The session (`lib/bff.ts`).** A request without its own `Authorization` header is sent with
 * the session cookie's token as the bearer; one with its own header (a service token, a test
 * client) is forwarded as sent and the cookie is not used. The few routes that issue or end a
 * session, or start and finish a Google / Microsoft flow, are answered here so the token and the
 * browser binding become cookies and never appear in a response body.
 *
 * The defaults are for local development. Deployments must set them.
 */
export async function proxy(request: NextRequest): Promise<Response> {
  const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";
  const mode = cookieMode(request);
  const { pathname, search } = request.nextUrl;

  // Before anything is matched on the path: an encoded variant of a route this proxy intercepts
  // must not reach the API as the plain route (`pathRefusal`).
  const unreadable = pathRefusal(pathname);
  if (unreadable) {
    return envelope(400, "PATH_ENCODING_REFUSED", "This address is not accepted in encoded form", {
      reason: unreadable,
    });
  }

  const cookieToken = request.cookies.get(mode.session)?.value;
  const ownBearer = request.headers.has("authorization");
  const ridesOnCookie = !ownBearer && Boolean(cookieToken);
  const oidc = oidcRoute(pathname);
  const signInRoute = SESSION_ISSUING_ROUTES.has(pathname) || oidc !== null;

  const refusal = crossSiteRefusal(request, ridesOnCookie || signInRoute);
  if (refusal) {
    return envelope(403, "CROSS_SITE_REQUEST_REFUSED", "This request did not come from this site", {
      reason: refusal,
    });
  }

  const headers = edgeRequestHeaders(request, process.env.EDGE_PROXY_SECRET);
  // The API reads no cookie. Forwarding them would only copy the session token into its logs.
  headers.delete("cookie");
  if (ridesOnCookie) headers.set("authorization", `Bearer ${cookieToken}`);

  if (request.method.toUpperCase() === "POST") {
    if (SESSION_ISSUING_ROUTES.has(pathname)) {
      return issueSession(mode, await forward(apiOrigin, pathname, headers, await request.text()));
    }
    if (oidc && oidc.step !== "callback") {
      return startOidc(request, apiOrigin, mode, headers, { provider: oidc.provider, step: oidc.step });
    }
    if (oidc) return completeOidc(request, apiOrigin, mode, headers, oidc.provider);
    if (pathname === "/api/v1/auth/logout") return logout(apiOrigin, mode, headers);
    const ending = sessionEndingRoute(pathname);
    // Only a request that rode on the cookie can have ended the cookie's session; a client with
    // its own bearer ended that bearer's, and the cookie (if any) is left alone.
    if (ending && ridesOnCookie) {
      return endingSession(mode, ending, await forward(apiOrigin, pathname, headers, await request.text()));
    }
  }

  return NextResponse.rewrite(new URL(`${pathname}${search}`, apiOrigin), { request: { headers } });
}

interface Upstream {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** Headers of the API's answer worth passing on to the page. */
const PASSED_HEADERS = ["x-request-id", "x-correlation-id", "retry-after"] as const;

/** Request headers that describe the browser's body or connection, not the one re-sent here. */
const RESENT_BODY_HEADERS = ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"];

async function forward(
  apiOrigin: string,
  pathname: string,
  headers: Headers,
  body: string,
): Promise<Upstream> {
  const sent = new Headers(headers);
  for (const name of RESENT_BODY_HEADERS) sent.delete(name);
  if (body !== "") sent.set("content-type", "application/json");
  else sent.delete("content-type");
  try {
    const response = await fetch(new URL(pathname, apiOrigin), {
      method: "POST",
      headers: sent,
      ...(body === "" ? {} : { body }),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    return { status: response.status, body: parseJson(text), headers: response.headers };
  } catch {
    return {
      status: 502,
      body: errorBody("API_UNREACHABLE", "The registry API could not be reached. Try again", true),
      headers: new Headers(),
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** The page's answer: the API's status and body, never a credential field. */
function answer(upstream: Upstream, extra: Record<string, string> = {}): NextResponse {
  const headers = new Headers({ "cache-control": "no-store", ...extra });
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return NextResponse.json(withoutCredentials(upstream.body), { status: upstream.status, headers });
}

function issueSession(
  mode: CookieMode,
  upstream: Upstream,
  extra: Record<string, string> = {},
): NextResponse {
  const response = answer(upstream, extra);
  const body = upstream.body as { sessionToken?: unknown; expiresAt?: unknown } | null;
  if (upstream.status === 200 && typeof body?.sessionToken === "string") {
    response.cookies.set(
      mode.session,
      body.sessionToken,
      cookieOptions(mode, sessionMaxAge(body.expiresAt)),
    );
  }
  return response;
}

async function logout(apiOrigin: string, mode: CookieMode, headers: Headers): Promise<NextResponse> {
  const upstream = await forward(apiOrigin, "/api/v1/auth/logout", headers, "");
  // A dead or missing token is still a sign-out from this browser's point of view.
  const response = answer(
    upstream.status === 200 ? upstream : { ...upstream, status: 200, body: { revoked: false } },
  );
  // Cleared whatever the API said: a dead token is no reason to keep the cookie.
  response.cookies.set(mode.session, "", cookieOptions(mode, 0));
  return response;
}

/**
 * Passes on the answer of a route that can end the request's own session, and clears the cookie
 * when the API says it did (`sessionEndingRoute`). Any other answer, a refusal included, leaves the
 * cookie as it was: the session is still live.
 */
function endingSession(mode: CookieMode, ending: SessionEnding, upstream: Upstream): NextResponse {
  const response = answer(upstream);
  const body = upstream.body as Record<string, unknown> | null;
  if (upstream.status === 200 && (ending === "always" || body?.[ending] === true)) {
    response.cookies.set(mode.session, "", cookieOptions(mode, 0));
  }
  return response;
}

async function startOidc(
  request: NextRequest,
  apiOrigin: string,
  mode: CookieMode,
  headers: Headers,
  route: { readonly provider: string; readonly step: "start" | "link_start" },
): Promise<NextResponse> {
  const text = route.step === "start" ? await request.text() : "";
  const purpose: OidcPurpose =
    route.step === "link_start"
      ? "link"
      : (parseJson(text) as { purpose?: unknown } | null)?.purpose === "invitation_accept"
        ? "invitation_accept"
        : "sign_in";
  const path =
    route.step === "start"
      ? `/api/v1/auth/oidc/${route.provider}/start`
      : `/api/v1/auth/oidc/${route.provider}/link/start`;
  const upstream = await forward(apiOrigin, path, headers, text);

  const response = answer(upstream);
  const binding = (upstream.body as { browserBinding?: unknown } | null)?.browserBinding;
  if (upstream.status === 200 && typeof binding === "string") {
    response.cookies.set(
      mode.oidc,
      encodeOidcBinding({ provider: route.provider, purpose, binding }),
      cookieOptions(mode, OIDC_MAX_AGE),
    );
  }
  return response;
}

async function completeOidc(
  request: NextRequest,
  apiOrigin: string,
  mode: CookieMode,
  headers: Headers,
  provider: string,
): Promise<NextResponse> {
  const kept = decodeOidcBinding(request.cookies.get(mode.oidc)?.value);
  const sent = parseJson(await request.text());

  if (
    !kept ||
    kept.provider !== provider ||
    typeof sent !== "object" ||
    sent === null ||
    Array.isArray(sent)
  ) {
    // Not started in this browser (or for another provider): never forwarded, so a callback URL
    // carried to another browser completes nothing there (login CSRF).
    const response = envelope(
      400,
      "OIDC_BINDING_MISSING",
      "This sign-in was not started in this browser. Start again",
    );
    response.cookies.set(mode.oidc, "", cookieOptions(mode, 0));
    return response;
  }

  const path =
    kept.purpose === "link"
      ? `/api/v1/auth/oidc/${provider}/link/callback`
      : `/api/v1/auth/oidc/${provider}/callback`;
  const upstream = await forward(
    apiOrigin,
    path,
    headers,
    JSON.stringify({ ...(sent as Record<string, unknown>), browserBinding: kept.binding }),
  );
  const extra = { "x-mpc-oidc-purpose": kept.purpose };
  const response =
    kept.purpose === "link" ? answer(upstream, extra) : issueSession(mode, upstream, extra);
  // One callback per flow: the API has spent or refused it either way.
  response.cookies.set(mode.oidc, "", cookieOptions(mode, 0));
  return response;
}

function errorBody(
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
) {
  return {
    code,
    message,
    retryable,
    correlationId: crypto.randomUUID(),
    ...(details ? { details } : {}),
  };
}

function envelope(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(errorBody(code, message, false, details), {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Every `/api` path except the streaming upload. Next.js buffers the body of a request a proxy
 * handles and keeps only `proxyClientMaxBodySize` (10 MiB) of it, so a large file would reach the
 * API cut off; that one route is a route handler that pipes the body on
 * (`app/api/v1/projects/[projectId]/uploads/stream/route.ts`, `lib/stream-upload.ts`).
 */
export const config = {
  matcher: ["/api/((?!v1/projects/[^/]+/uploads/stream$).*)"],
};
