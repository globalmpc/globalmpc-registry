"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listIdentities,
  startOidcLink,
  unlinkIdentity,
  type AuthMethods,
  type ExternalIdentity,
  type OidcProvider,
} from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { navigation } from "@/components/auth/ProviderButtons";
import { ErrorLine, useAction } from "./useAction";

const C = AUTH_COPY.settings;

/**
 * Linked Google / Microsoft sign-ins (WP4). Linking needs a session past its second factor, and it
 * comes back to this same session through the callback page; unlinking ends the sessions that
 * identity signed in, possibly this one (`onSessionEnded`).
 */
export function IdentitiesSection({
  methods,
  onSessionEnded,
  onAccountChanged,
}: {
  readonly methods: AuthMethods | null;
  readonly onSessionEnded: () => void;
  /** After an unlink: the sessions that signed in with it ended, so the list is read again. */
  readonly onAccountChanged?: () => void;
}) {
  const [items, setItems] = useState<ExternalIdentity[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await listIdentities()).items.filter((item) => item.revokedAt === null));
      setLoadError(null);
    } catch (caught) {
      setLoadError(authErrorMessage(caught));
    }
  }, []);
  const changed = useCallback(async () => {
    await load();
    onAccountChanged?.();
  }, [load, onAccountChanged]);
  const { act, busy, error } = useAction(changed);

  useEffect(() => {
    void load();
  }, [load]);

  const linkable = (["google", "microsoft"] as const).filter(
    (provider) => methods?.[provider] && !items.some((item) => item.provider === provider),
  );

  return (
    <div className="panel" data-testid="settings-identities">
      <h2>{C.identities}</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        {C.identitiesLead}
      </p>
      <ErrorLine error={loadError ?? error} />
      {items.length === 0 ? <p className="meta">{C.noIdentities}</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {AUTH_COPY.providers[item.provider]}{" "}
            <span className="meta">
              · {C.linkedVia(item.linkedVia)} ·{" "}
              {item.lastUsedAt ? C.used(item.lastUsedAt.slice(0, 10)) : C.never}
            </span>{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await unlinkIdentity(item.id);
                  if (result.currentSessionEnded) onSessionEnded();
                })
              }
            >
              {C.unlink}
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        {linkable.map((provider: OidcProvider) => (
          <button
            key={provider}
            type="button"
            disabled={busy}
            data-testid={`link-${provider}`}
            onClick={() =>
              void act(async () => {
                const { authorizationUrl } = await startOidcLink(provider);
                navigation.assign(authorizationUrl);
              })
            }
          >
            {C.link(AUTH_COPY.providers[provider] ?? provider)}
          </button>
        ))}
      </div>
    </div>
  );
}
