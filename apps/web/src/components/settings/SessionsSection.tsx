"use client";

import { useCallback, useEffect, useState } from "react";
import { listSessions, revokeSession, type AccountSessionItem } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { ErrorLine, useAction } from "./useAction";

const C = AUTH_COPY.settings;

const FACTOR: Readonly<Record<string, string>> = {
  email_code: "emailed code",
  google: "Google",
  microsoft: "Microsoft",
  passkey: "passkey",
  totp: "authenticator app",
  recovery_code: "recovery code",
};

/**
 * Where this account is signed in (WP7). Each live session with how it signed in and when it was
 * last used; any other one can be ended from here. This browser's own session ends through
 * sign-out, so the cookie goes with it — the revocation route alone would leave it behind.
 */
export function SessionsSection({
  onSignOut,
  reloadKey = 0,
}: {
  readonly onSignOut: () => void;
  /**
   * Bumped by the other sections after an action that can end sessions or change this one's
   * factors (removing a factor, unlinking, regenerating codes, a step-up): the list is read again.
   */
  readonly reloadKey?: number;
}) {
  const [items, setItems] = useState<AccountSessionItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await listSessions()).items);
      setLoadError(null);
    } catch (caught) {
      setLoadError(authErrorMessage(caught));
    }
  }, []);
  const { act, busy, error } = useAction(load);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  return (
    <div className="panel" data-testid="settings-sessions">
      <h2>{C.sessions}</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        {C.sessionsLead}
      </p>
      <ErrorLine error={loadError ?? error} />
      <ul data-testid="session-list">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid={item.current ? "session-current" : "session-other"}
            data-session-id={item.id}
          >
            {FACTOR[item.firstFactor] ?? item.firstFactor}
            {item.secondFactor ? ` + ${FACTOR[item.secondFactor] ?? item.secondFactor}` : ""}{" "}
            <span className="meta">
              · {C.signedInAt(item.createdAt.slice(0, 16).replace("T", " "))}
              {item.lastSeenAt ? ` · ${C.used(item.lastSeenAt.slice(0, 16).replace("T", " "))}` : ""}
            </span>{" "}
            {item.current ? (
              <strong>{C.thisBrowser}</strong>
            ) : (
              <button type="button" disabled={busy} onClick={() => void act(() => revokeSession(item.id))}>
                {C.endSession}
              </button>
            )}
          </li>
        ))}
      </ul>
      {/* Always offered, even when the list cannot be read. */}
      <button type="button" onClick={onSignOut}>
        {AUTH_COPY.mfa.signOut}
      </button>
    </div>
  );
}
