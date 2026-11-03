"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { completeOidc, type OidcCallbackInput, type OidcProvider } from "@/lib/account-api";
import { readCallback } from "@/lib/oidc-callback";
import { pendingInvitation } from "@/lib/pending-invitation";
import { authErrorMessage } from "@/lib/auth-errors";
import { landingPath } from "@/lib/next-path";
import { AUTH_COPY } from "@/lib/copy";
import { needsSecondFactor, useSession } from "@/lib/session";

const C = AUTH_COPY.oidc;

/**
 * The redirect URI registered with Google and Microsoft: `<WEB_ORIGIN>/auth/oidc/{provider}/callback`.
 *
 * It completes whichever flow this browser started — sign-in, invitation acceptance or linking —
 * because the web server knows which one from its cookie; the page only reports the outcome.
 */
export default function OidcCallbackPage() {
  const params = useParams<{ provider: string }>();
  const provider = params.provider === "microsoft" ? "microsoft" : params.provider === "google" ? "google" : null;
  const router = useRouter();
  const { refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const input = readCallback(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    if (!provider || !input) {
      setError(AUTH_COPY.errors["OIDC_STATE_INVALID"] ?? "");
      return;
    }
    void finish(provider, input);

    async function finish(which: OidcProvider, sent: OidcCallbackInput) {
      try {
        const { purpose } = await completeOidc(which, sent);
        if (purpose === "invitation_accept") pendingInvitation.clear();
        if (purpose === "link") {
          setLinked(true);
          await refresh();
          return;
        }
        const fresh = await refresh();
        router.replace(needsSecondFactor(fresh) ? "/auth/mfa" : landingPath(fresh));
      } catch (caught) {
        setError(authErrorMessage(caught));
      }
    }
  }, [provider, refresh, router]);

  if (linked) {
    return (
      <div className="panel" data-testid="oidc-linked">
        <p className="sub">{C.linked(AUTH_COPY.providers[provider ?? ""] ?? String(provider))}</p>
        <Link href="/w/settings">{C.backToSettings}</Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert" data-testid="oidc-error">
        <div className="title">{C.failedHeading}</div>
        {error}
        <div style={{ marginTop: 8 }}>
          {/* An invitation being accepted falls back to the emailed code (OIDC_EMAIL_CODE_REQUIRED). */}
          {pendingInvitation.read() ? (
            <Link href="/invitations/accept">{AUTH_COPY.invitation.sendCode} →</Link>
          ) : (
            <Link href="/connect">{C.back}</Link>
          )}
        </div>
      </div>
    );
  }

  return <p className="sub">{C.completing}</p>;
}
