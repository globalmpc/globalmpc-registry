"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getAuthMethods,
  startInvitationAcceptance,
  verifyInvitationAcceptance,
  type AuthMethods,
} from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { readInvitationToken } from "@/lib/oidc-callback";
import { pendingInvitation } from "@/lib/pending-invitation";
import { useSession } from "@/lib/session";
import { EmailCodeForm } from "@/components/auth/EmailCodeForm";
import { ProviderButtons } from "@/components/auth/ProviderButtons";

const C = AUTH_COPY.invitation;

/**
 * Accepting an invitation — journey 1.
 *
 * The link is `/invitations/accept#token=…`. **The token is in the fragment**, which the browser
 * never puts in a request line, a `Referer` or a server log; this page reads it, removes it from
 * the address bar, and sends it only in request bodies. Then: a code mailed to the invited address
 * (or Google / Microsoft where the provider vouches for that address), a display name, a
 * first-factor session, and the second-factor enrolment on `/auth/mfa`.
 */
export default function AcceptInvitationPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [sent, setSent] = useState<{ at: number; count: number; minutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromLink = readInvitationToken(window.location.hash);
    if (fromLink) {
      // Out of the address bar before anything else happens on this page.
      window.history.replaceState(null, "", window.location.pathname);
      pendingInvitation.keep(fromLink);
    }
    // Coming back from a provider that could not vouch for the address: the tab still holds it.
    setToken(fromLink ?? pendingInvitation.read());
    setReady(true);
    getAuthMethods()
      .then(setMethods)
      .catch(() => setMethods(null));
  }, []);

  async function sendCode(current: string) {
    const answer = await startInvitationAcceptance(current);
    setSent((previous) => ({
      at: Date.now(),
      count: (previous?.count ?? 0) + 1,
      minutes: answer.expiresInMinutes,
    }));
  }

  if (!ready) return null;

  if (!token) {
    return (
      <div className="notice" style={{ color: "var(--alert)" }} data-testid="invitation-missing">
        <div className="title">{C.heading}</div>
        {C.missing}
      </div>
    );
  }

  const name = displayName.trim();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{C.heading}</h1>
          <p className="sub">{C.lead}</p>
        </div>
      </div>

      <div className="panel" data-testid="invitation-accept">
        {error ? (
          <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
            {error}
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="display-name">{C.nameLabel}</label>
          <input
            id="display-name"
            autoComplete="name"
            maxLength={200}
            value={displayName}
            disabled={sent !== null}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        {sent === null ? (
          <>
            <button
              className="primary"
              type="button"
              disabled={busy || name === ""}
              onClick={() => {
                setBusy(true);
                setError(null);
                sendCode(token)
                  .catch((caught: unknown) => setError(authErrorMessage(caught)))
                  .finally(() => setBusy(false));
              }}
            >
              {C.sendCode}
            </button>
            {methods && (methods.google || methods.microsoft) ? (
              <div style={{ marginTop: 12 }}>
                <p className="meta">{AUTH_COPY.signIn.or}</p>
                <ProviderButtons
                  methods={methods}
                  disabled={name === ""}
                  start={{ purpose: "invitation_accept", invitationToken: token, displayName: name }}
                />
              </div>
            ) : null}
          </>
        ) : (
          <EmailCodeForm
            digits={methods?.emailCodeDigits ?? 8}
            expiresInMinutes={sent.minutes}
            sentAt={sent.at}
            sends={sent.count}
            submitLabel={C.accept}
            onResend={() => sendCode(token)}
            onSubmit={async (code) => {
              await verifyInvitationAcceptance(token, code, name);
              pendingInvitation.clear();
              await refresh();
              router.push("/auth/mfa");
            }}
          />
        )}
      </div>
    </>
  );
}
