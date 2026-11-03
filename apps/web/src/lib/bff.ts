import type { NextRequest } from "next/server";

/**
 * The web server's side of the session — account authentication WP6 (plan §5, threat model T10).
 *
 * **The session token never reaches page script.** The API stays bearer-based (service tokens and
 * the CLI are unchanged); this server keeps the browser's token in an HttpOnly cookie and turns it
 * into `Authorization: Bearer` on the way to the API. A script injected into the page can still act
 * as the person while the page is open, but it cannot read the token and carry it elsewhere.
 *
 * Decisions, and why:
 *
 * - **`SameSite=Strict`.** Every request that needs the cookie is a same-origin `fetch` from our own
 *   pages; none is a navigation arriving from another site (the provider redirect lands on a page,
 *   and that page then calls the API itself). Strict also withholds the cookie from a top-level
 *   cross-site GET, which Lax would not. Nothing depends on Lax, so the narrower setting costs nothing.
 * - **`__Host-` prefix in production.** It forces `Secure`, `Path=/` and no `Domain`, so a sibling
 *   subdomain cannot plant or overwrite the cookie. Plain `http://` development cannot hold a Secure
 *   cookie on every host, so outside production and outside https the cookie is unprefixed and not
 *   Secure — and production reads only the prefixed name, so the unprefixed one can never be planted
 *   there.
 * - **CSRF: `Sec-Fetch-Site`, then `Origin`.** The cookie is ambient, so a state-changing request is
 *   refused unless the browser says it came from this origin. A request that sends neither header is
 *   accepted only when it does not ride on the cookie (a CLI or test client with its own bearer).
 *   No double-submit token: both headers are set by the browser and cannot be forged by a page on
 *   another site, and a token would have to live somewhere script can read.
 * - **The OIDC browser binding** (WP4 login CSRF) is kept in a second HttpOnly cookie for the ten
 *   minutes a flow lives; the callback page never sees it, and it never travels in a URL.
 */

export const SESSION_COOKIE = "__Host-mpc_session";
export const SESSION_COOKIE_INSECURE = "mpc_session";
export const OIDC_COOKIE = "__Host-mpc_oidc";
export const OIDC_COOKIE_INSECURE = "mpc_oidc";

/** Minutes a started OIDC flow lives at the API (`OIDC_TRANSACTION_TTL_MINUTES`). */
const OIDC_COOKIE_MAX_AGE_SECONDS = 10 * 60;
/** Absolute session lifetime at the API (8 h). The API's own expiry still decides. */
const SESSION_COOKIE_FALLBACK_MAX_AGE_SECONDS = 8 * 60 * 60;

export interface CookieMode {
  readonly secure: boolean;
  readonly session: string;
  readonly oidc: string;
}

/**
 * Secure in production always — a TLS-terminating platform in front of this server makes the
 * request look like plain http, and that must not downgrade the cookie. Elsewhere, Secure when the
 * request itself is https.
 */
export function cookieMode(request: NextRequest, nodeEnv = process.env.NODE_ENV): CookieMode {
  const secure = nodeEnv === "production" || request.nextUrl.protocol === "https:";
  return secure
    ? { secure, session: SESSION_COOKIE, oidc: OIDC_COOKIE }
    : { secure, session: SESSION_COOKIE_INSECURE, oidc: OIDC_COOKIE_INSECURE };
}

export interface CookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "strict";
  readonly path: "/";
  readonly maxAge: number;
}

export function cookieOptions(mode: CookieMode, maxAge: number): CookieOptions {
  return { httpOnly: true, secure: mode.secure, sameSite: "strict", path: "/", maxAge };
}

/** Seconds until `expiresAt`, bounded to the session's absolute lifetime. */
export function sessionMaxAge(expiresAt: unknown, now = Date.now()): number {
  const at = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(at)) return SESSION_COOKIE_FALLBACK_MAX_AGE_SECONDS;
  return Math.max(0, Math.min(SESSION_COOKIE_FALLBACK_MAX_AGE_SECONDS, Math.floor((at - now) / 1000)));
}

export const OIDC_MAX_AGE = OIDC_COOKIE_MAX_AGE_SECONDS;

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origin this web app is served from. `WEB_ORIGIN` when set (behind a proxy, set it). */
export function expectedOrigin(request: NextRequest, webOrigin = process.env.WEB_ORIGIN): string {
  if (webOrigin) {
    try {
      return new URL(webOrigin).origin;
    } catch {
      // A malformed value must not open the check; fall through to the request's own origin.
    }
  }
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${request.nextUrl.protocol}//${host}`;
}

/**
 * Why a request is refused as cross-site, or `null` when it may proceed.
 *
 * `ridesOnCookie`: the request would be authenticated by the session cookie (no bearer of its
 * own). Sign-in routes are checked whatever they carry: a cross-site page completing *its*
 * sign-in in the victim's browser (login CSRF) is refused the same way.
 */
export function crossSiteRefusal(
  request: NextRequest,
  ridesOnCookie: boolean,
  webOrigin = process.env.WEB_ORIGIN,
): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return fetchSite === "same-origin" ? null : `sec-fetch-site:${fetchSite}`;
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return origin === expectedOrigin(request, webOrigin) ? null : "origin";
  }
  return ridesOnCookie ? "no-origin" : null;
}

/** `/api/v1/auth` and everything under it, compared after decoding and without regard to case. */
const AUTH_PATH = /^\/api\/v1\/auth(?:\/|$)/i;

/**
 * Why an `/api` path cannot be handled as written, or `null` (WP6 review M1, L1).
 *
 * Which requests become cookies is decided by the literal path (`SESSION_ISSUING_ROUTES`,
 * `oidcRoute`, logout). The API decodes percent-encoding, so `/api/v1/auth/email/%76erify` would
 * reach the verify handler past that decision and answer the token in a readable body; and the
 * rewrite's URL parsing resolves an encoded dot segment, so `/api/v1/x/%2e%2e/auth/email/verify`
 * would arrive as the literal route. Refused here:
 *
 * - `malformed` — an escape that does not decode;
 * - `dot_segment` — a segment that is, or decodes to, `.` or `..`;
 * - `encoded_auth` — any percent-encoding in a path that decodes into `/api/v1/auth`. No auth route
 *   takes a value that needs encoding (UUIDs, base64url, a provider name).
 *
 * Encoding elsewhere is legitimate — a public registry key is free text — and is forwarded as sent;
 * nothing outside `/api/v1/auth` is intercepted, so the API's own decoding decides no cookie.
 */
export function pathRefusal(pathname: string): "malformed" | "dot_segment" | "encoded_auth" | null {
  for (const segment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return "malformed";
    }
    if (decoded === "." || decoded === ".." || segment === "." || segment === "..") return "dot_segment";
  }
  if (pathname.includes("%") && AUTH_PATH.test(decodeURIComponent(pathname))) return "encoded_auth";
  return null;
}

export type OidcPurpose = "sign_in" | "invitation_accept" | "link";

export interface OidcBinding {
  readonly provider: string;
  readonly purpose: OidcPurpose;
  readonly binding: string;
}

const PURPOSES: ReadonlySet<string> = new Set(["sign_in", "invitation_accept", "link"]);
const BINDING = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER = /^[a-z]{1,32}$/;

export function encodeOidcBinding(value: OidcBinding): string {
  return `${value.provider}.${value.purpose}.${value.binding}`;
}

/** `null` for anything that is not exactly what `encodeOidcBinding` wrote. */
export function decodeOidcBinding(raw: string | undefined): OidcBinding | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [provider, purpose, binding] = parts as [string, string, string];
  if (!PROVIDER.test(provider) || !PURPOSES.has(purpose) || !BINDING.test(binding)) return null;
  return { provider, purpose: purpose as OidcPurpose, binding };
}

/** API routes whose answer carries a fresh session token, which this server turns into a cookie. */
export const SESSION_ISSUING_ROUTES: ReadonlySet<string> = new Set([
  "/api/v1/auth/email/verify",
  "/api/v1/auth/invitations/accept/verify",
]);

/**
 * `/api/v1/auth/oidc/{provider}/{start|link/start|callback|link/callback}` → its parts, else
 * `null`. Both callbacks are one step here: which API route completes the flow is decided by the
 * purpose kept in the binding cookie, not by the page.
 */
export function oidcRoute(
  pathname: string,
): { readonly provider: string; readonly step: "start" | "link_start" | "callback" } | null {
  const match = /^\/api\/v1\/auth\/oidc\/([a-z]{1,32})\/(start|link\/start|callback|link\/callback)$/.exec(
    pathname,
  );
  if (!match) return null;
  const step =
    match[2] === "link/start" ? "link_start" : match[2] === "start" ? "start" : "callback";
  return { provider: match[1]!, step };
}

/** How a session-ending route's answer says it ended the request's own session. */
export type SessionEnding = "current" | "currentSessionEnded" | "always";

/**
 * The routes that can end the very session they are sent with, and how the answer says so:
 * revoking a session from the list (`current`), unlinking the identity the session signed in with
 * and removing a passkey or the authenticator app (`currentSessionEnded`), and disabling one's own
 * wallet, which ends every session of the person (`always`). The proxy clears the cookie when the
 * answer says so, as logout does, so the browser does not keep sending a token the server has
 * already ended. `null` for any other path.
 */
export function sessionEndingRoute(pathname: string): SessionEnding | null {
  if (/^\/api\/v1\/auth\/sessions\/[^/]+\/revocation$/.test(pathname)) return "current";
  if (/^\/api\/v1\/auth\/identities\/[^/]+\/unlink$/.test(pathname)) return "currentSessionEnded";
  if (/^\/api\/v1\/auth\/mfa\/passkeys\/[^/]+\/removal$/.test(pathname)) return "currentSessionEnded";
  if (pathname === "/api/v1/auth/mfa/totp/removal") return "currentSessionEnded";
  if (/^\/api\/v1\/auth\/wallets\/[^/]+\/disable$/.test(pathname)) return "always";
  return null;
}

/**
 * Removes every field that would hand page script a credential. The token becomes the cookie; the
 * binding becomes the OIDC cookie. Nothing else in these answers is secret.
 */
export function withoutCredentials(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const { sessionToken: _token, browserBinding: _binding, ...rest } = body as Record<string, unknown>;
  return rest;
}
