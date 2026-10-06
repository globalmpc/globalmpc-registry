import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Same-origin proxy from `/api/*` to the API server.
 *
 * Why a proxy instead of opening CORS: browser requests become same-origin, so moving to session
 * cookies can use SameSite settings as-is. With CORS plus cross-origin cookies,
 * a configuration mistake becomes an authentication bypass.
 *
 * **There is a reason this lives here and not in `rewrites()` in `next.config.ts`.** `rewrites()` is
 * evaluated at build time and the destination string is baked into `routes-manifest.json`. The API address
 * is unknown when the image is built, so the default `http://localhost:3001` gets baked in, and the
 * `API_ORIGIN` given at runtime is ignored — inside a container localhost is the container itself, so
 * every API call has nowhere to go. The proxy runs per request, so it reads the environment
 * variables at that moment.
 *
 * The default is for local development. Deployments always provide it.
 */
export function proxy(request: NextRequest): NextResponse {
  const origin = process.env.API_ORIGIN ?? "http://localhost:3001";
  const { pathname, search } = request.nextUrl;

  return NextResponse.rewrite(new URL(`${pathname}${search}`, origin));
}

export const config = {
  matcher: "/api/:path*",
};
