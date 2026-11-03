import type { OidcCallbackInput } from "./account-api";

/**
 * What the provider sent back to the callback page, read once from the query.
 *
 * `code` and `state` must not stay in the URL afterwards: history, a shared screenshot or a later
 * `Referer` would carry them, so the page removes them before it does anything else. The browser
 * binding is not here and never was — the web server holds it as an HttpOnly cookie set when the
 * flow started, and adds it to the callback itself (`proxy.ts`).
 */
export function readCallback(search: string): OidcCallbackInput | null {
  const params = new URLSearchParams(search);
  const state = params.get("state");
  if (!state) return null;
  const error = params.get("error");
  if (error) return { state, error };
  const code = params.get("code");
  if (!code) return null;
  const iss = params.get("iss");
  return { state, code, ...(iss ? { iss } : {}) };
}

/** An invitation token from the link's fragment (`#token=…`), never from the query. */
export function readInvitationToken(hash: string): string | null {
  const value = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("token");
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
