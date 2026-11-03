import type { SessionInfo } from "./api";
import { accessPending, rolesAllInactive } from "./access";

/**
 * A `next` path is only ever a same-site path: `/w/...`, never `//host` or `https://…`.
 * Anything else falls back to the workspace, so a crafted sign-in link cannot send the person
 * to another site after they sign in.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/w/projects"): string {
  return explicitPath(raw) ?? fallback;
}

function explicitPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/[\u0000-\u001f]/u.test(raw)) return null;
  return raw;
}

export function currentNextPath(fallback?: string): string {
  if (typeof window === "undefined") return fallback ?? "/w/projects";
  return safeNextPath(new URLSearchParams(window.location.search).get("next"), fallback);
}

/** The `next` path in the address bar, if one was given and is safe. */
export function explicitNextPath(): string | null {
  if (typeof window === "undefined") return null;
  return explicitPath(new URLSearchParams(window.location.search).get("next"));
}

/**
 * Where a signed-in session lands when no `next` was asked for.
 *
 * A person with no usable role lands on "access pending" (plan §4 journey 1), not on a project
 * list that answers only with a refusal. The workspace gate shows the same explanation on any
 * other workspace screen, so an explicit `next` is still honoured.
 */
export function landingPath(session: SessionInfo | null | undefined, next?: string | null): string {
  const explicit = explicitPath(next);
  if (explicit) return explicit;
  return accessPending(session) || rolesAllInactive(session) ? "/w/access-pending" : "/w/projects";
}

/** `landingPath` for the `next` in the address bar. */
export function currentLandingPath(session: SessionInfo | null | undefined): string {
  return landingPath(session, explicitNextPath());
}
