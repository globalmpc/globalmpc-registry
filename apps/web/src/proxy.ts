import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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
 * Proxies `/api/*` to the API server as same-origin.
 *
 * Why a proxy instead of opening CORS: browser requests stay same-origin, so the SameSite
 * setting carries over unchanged when switching to session cookies. CORS plus cross-origin
 * cookies turns a configuration slip into an auth bypass.
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
 * The defaults are for local development. Deployments must set them.
 */
export function proxy(request: NextRequest): NextResponse {
  const origin = process.env.API_ORIGIN ?? "http://localhost:3001";
  const { pathname, search } = request.nextUrl;

  return NextResponse.rewrite(new URL(`${pathname}${search}`, origin), {
    request: { headers: edgeRequestHeaders(request, process.env.EDGE_PROXY_SECRET) },
  });
}

export const config = {
  matcher: "/api/:path*",
};
