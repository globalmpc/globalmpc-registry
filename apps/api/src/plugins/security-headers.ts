import type { FastifyInstance } from "fastify";

/**
 * Security headers for API responses — 10 §10.6.
 *
 * The web CSP lives in `apps/web/next.config.ts`. That policy is for documents that render
 * screens; this is **a surface that returns only JSON**. So the policy is not "what to
 * allow" but `default-src 'none'` — an API response has no reason to load scripts or
 * sit in a frame.
 *
 * The headers block what happens on the browser side **after** passing server authorization.
 * A value reflected in an error body being interpreted as a document, content sniffing, and
 * framing are out of reach of authorization code.
 *
 * In deployment the browser reaches here through `web`'s `/api/*` proxy, but the moment the API
 * is exposed directly another way (debugging, a separate domain, internal tools), headers the
 * proxy added disappear. So the API attaches its own headers.
 */

export interface SecurityHeaderOptions {
  /** Send HSTS only in production. */
  readonly production: boolean;
}

/** One year. A preload requirement; anything shorter leaves a MITM downgrade window. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

export function securityHeaders(
  options: SecurityHeaderOptions,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-security-policy": [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    // Legacy header with the same meaning, for browsers that cannot read CSP frame-ancestors.
    "x-frame-options": "DENY",
    // API responses have no links for users to follow. There is no referrer to send.
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), camera=(), microphone=(), payment=()",
    "cross-origin-resource-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
  };

  /**
   * HSTS is sent only in production.
   *
   * Local is http. A browser that receives HSTS there remembers the host as https-only, which
   * also blocks other local projects using the same hostname. Developers must clear it in the
   * browser settings to undo it, so it is not the default.
   */
  if (options.production) {
    headers["strict-transport-security"] =
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;
  }

  return headers;
}

export async function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeaderOptions,
): Promise<void> {
  const headers = securityHeaders(options);

  /**
   * Attached at `onRequest`.
   *
   * Cap overruns (429) and error responses must get the same headers. Attaching them only on the
   * normal path drops them from exactly the responses most likely to reflect values.
   */
  app.addHook("onRequest", async (_request, reply) => {
    for (const [name, value] of Object.entries(headers)) {
      reply.header(name, value);
    }
  });
}
