import type { FastifyInstance } from "fastify";

/** The route a browser may call directly when the web app sits behind an edge proxy. */
export const STREAM_UPLOAD_PATH_PATTERN = /^\/api\/v1\/projects\/[^/]+\/uploads\/stream$/;

/** Request headers the web client sends on that route. Nothing else is admitted. */
const ALLOWED_REQUEST_HEADERS = "authorization, idempotency-key, content-type";

function pathOf(url: string): string {
  const cut = url.indexOf("?");
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Cross-origin access for the streaming upload route — one route, one origin.
 *
 * Behind a CDN the web app proxies `/api/*` to this server, and the CDN cuts a proxied request
 * long before a multi-gigabyte upload finishes. The browser therefore posts that one route
 * straight to the API host. Everything else keeps going through the proxy, so CORS is not
 * opened generally: the origin must equal `EDGE_WEB_ORIGIN` byte for byte, the route must be
 * the streaming upload, and no credentials flag is set — the session travels as a Bearer
 * header, never as a cookie.
 *
 * Unset origin means this hook adds nothing and preflights fall through to the 404 they got
 * before.
 */
export async function registerStreamUploadCors(
  app: FastifyInstance,
  allowedOrigin: string | null,
): Promise<void> {
  if (allowedOrigin === null) return;

  app.addHook("onRequest", async (request, reply) => {
    if (!STREAM_UPLOAD_PATH_PATTERN.test(pathOf(request.url))) return;
    if (request.headers.origin !== allowedOrigin) return;

    reply.header("access-control-allow-origin", allowedOrigin);
    reply.header("vary", "origin");

    if (request.method !== "OPTIONS") return;
    reply.header("access-control-allow-methods", "POST");
    reply.header("access-control-allow-headers", ALLOWED_REQUEST_HEADERS);
    reply.header("access-control-max-age", "600");
    return reply.status(204).send();
  });
}
