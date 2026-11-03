"use client";

import { useState } from "react";
import { startOidc, type AuthMethods, type OidcProvider, type OidcStart } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";

/** Top-level navigation to the provider. A seam for tests, which cannot leave the page. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/**
 * "Continue with Google / Microsoft" — only for the providers this deployment configured.
 *
 * Starting a flow sets the browser binding as an HttpOnly cookie (the web server does, `proxy.ts`);
 * this page receives only the provider's URL and leaves for it.
 */
export function ProviderButtons({
  methods,
  start,
  disabled,
}: {
  readonly methods: Pick<AuthMethods, "google" | "microsoft"> | null;
  readonly start: OidcStart;
  readonly disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = (["google", "microsoft"] as const).filter((provider) => methods?.[provider]);
  if (providers.length === 0) return null;

  async function go(provider: OidcProvider) {
    setBusy(true);
    setError(null);
    try {
      const { authorizationUrl } = await startOidc(provider, start);
      navigation.assign(authorizationUrl);
    } catch (caught) {
      setError(authErrorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div data-testid="provider-buttons">
      {error ? (
        <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
          {error}
        </div>
      ) : null}
      <div className="row">
        {providers.map((provider) => (
          <button
            key={provider}
            type="button"
            disabled={busy || disabled}
            data-testid={`oidc-${provider}`}
            onClick={() => void go(provider)}
          >
            {AUTH_COPY.signIn.withProvider(AUTH_COPY.providers[provider] ?? provider)}
          </button>
        ))}
      </div>
    </div>
  );
}
