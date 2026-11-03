import type { OidcFetch } from "./oidc.js";

/**
 * E2E stand-in for Google and Microsoft — **test builds only** (`OIDC_TEST_RELAY_URL`; `loadConfig`
 * refuses it in production and on mainnet).
 *
 * The OIDC library keeps talking to the real issuer URLs, so discovery, issuer and audience checks
 * run exactly as in production; only the transport changes. Every request to
 * `https://<host><path><query>` goes to `<relay>/<host><path><query>` with the same method,
 * headers and body, and the relay (`apps/web/e2e/`) answers as the provider would, with metadata
 * whose endpoints still name the real hosts.
 *
 * Only the provider hosts are rewritten. Anything else throws instead of being fetched: in a test
 * build a request to an unexpected host is a defect to surface, and it must never leave for the
 * network with test credentials.
 */
export const OIDC_RELAY_HOSTS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "login.microsoftonline.com",
]);

/** `https://<provider host><path><query>` → `<relay>/<host><path><query>`. */
export function relayUrl(relayBase: string, target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("OIDC test relay: not a URL");
  }
  // A port or credentials would mean a URL no provider publishes; refuse rather than drop them.
  if (
    url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== ""
    || !OIDC_RELAY_HOSTS.has(url.hostname)
  ) {
    throw new Error(`OIDC test relay: refusing a request to ${url.protocol}//${url.host}`);
  }
  return `${relayBase.replace(/\/+$/, "")}/${url.hostname}${url.pathname}${url.search}`;
}

/** The `deps.oidcFetch` `main.ts` passes when the relay is configured. */
export function createOidcTestRelayFetch(relayBase: string, fetchImpl: typeof fetch = fetch): OidcFetch {
  return (target, options) => fetchImpl(relayUrl(relayBase, target), options as RequestInit);
}
