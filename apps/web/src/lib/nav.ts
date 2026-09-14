import { NAV, type NavEntry } from "./copy";

/** Session facts needed to filter menus. */
export interface NavSession {
  readonly actions?: readonly string[];
  readonly subjectId?: string | null;
}

/**
 * Workspace menus visible to this session — spec 11 §11.2.
 *
 * The web does not keep its own role→action table. It reads only the action list the server gave the session —
 * two tables eventually diverge, and then the menu disagrees with the server.
 */
export function visibleNav(session: NavSession): readonly NavEntry[] {
  const actions = session.actions ?? [];
  return NAV.filter((entry) =>
    entry.requires === "subject" ? Boolean(session.subjectId) : actions.includes(entry.requires),
  );
}
