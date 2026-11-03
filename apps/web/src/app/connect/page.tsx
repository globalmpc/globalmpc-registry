"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";
import { getAuthMethods, startEmailSignIn, verifyEmailSignIn, type AuthMethods } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { explicitNextPath, landingPath } from "@/lib/next-path";
import { needsSecondFactor, useSession } from "@/lib/session";
import { EmailCodeForm } from "@/components/auth/EmailCodeForm";
import { ProviderButtons } from "@/components/auth/ProviderButtons";

const C = AUTH_COPY.signIn;

/**
 * Sign-in — this screen lives at `/connect`, not `/`.
 *
 * While `/` was the sign-in screen, there was no public entry point explaining the product.
 * Sign-in is one branch of the public surface, not its entrance.
 *
 * Account sign-in (WP6): an emailed code, or Google / Microsoft where configured, then the second
 * factor on `/auth/mfa`. No wallet is needed to sign in, and none can be used to: a wallet is a
 * signing key, asked for only when something is signed (WP7 removed the transitional wallet
 * sign-in).
 */
export default function SignInPage() {
  const { session, loading, refresh } = useSession();
  const router = useRouter();
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ at: number; count: number; minutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAuthMethods()
      .then(setMethods)
      .catch(() => setMethods(null));
  }, []);

  /**
   * Where a fresh session goes: the second factor first, unless it already holds one. Without an
   * asked-for `next`, the landing follows the session's roles (no role: "access pending").
   */
  async function afterSignIn() {
    const next = explicitNextPath();
    const fresh = await refresh();
    if (needsSecondFactor(fresh)) {
      router.push(next ? `/auth/mfa?next=${encodeURIComponent(next)}` : "/auth/mfa");
      return;
    }
    router.push(landingPath(fresh, next));
  }

  async function sendCode() {
    const answer = await startEmailSignIn(email.trim());
    setSent((previous) => ({
      at: Date.now(),
      count: (previous?.count ?? 0) + 1,
      minutes: answer.expiresInMinutes,
    }));
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{C.heading}</h1>
          <p className="sub">{C.lead}</p>
        </div>
      </div>

      {!loading && session?.authenticated && !needsSecondFactor(session) ? (
        <p className="sub">
          {C.alreadySignedIn} <a href={landingPath(session)}>{C.goToWorkspace}</a>
        </p>
      ) : null}

      <div className="panel" data-testid="email-sign-in">
        {sent === null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              sendCode()
                .catch((caught: unknown) => setError(authErrorMessage(caught)))
                .finally(() => setBusy(false));
            }}
          >
            {error ? (
              <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
                {error}
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="sign-in-email">{C.emailLabel}</label>
              <input
                id="sign-in-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <button className="primary" type="submit" disabled={busy || email.trim() === ""}>
              {busy ? C.sending : C.sendCode}
            </button>
          </form>
        ) : (
          <>
            <h2>{C.codeHeading}</h2>
            <p className="sub" style={{ marginTop: 0 }} data-testid="code-sent">
              {C.codeSent(sent.minutes)}
            </p>
            <EmailCodeForm
              digits={methods?.emailCodeDigits ?? 8}
              expiresInMinutes={sent.minutes}
              sentAt={sent.at}
              sends={sent.count}
              onResend={sendCode}
              onSubmit={async (code) => {
                await verifyEmailSignIn(email.trim(), code);
                await afterSignIn();
              }}
            />
            <p className="meta">
              <button type="button" className="link" onClick={() => setSent(null)}>
                {C.otherAddress}
              </button>
            </p>
          </>
        )}

        {methods && (methods.google || methods.microsoft) ? (
          <>
            <p className="meta">{C.or}</p>
            <ProviderButtons methods={methods} start={{ purpose: "sign_in" }} />
          </>
        ) : null}
        <p className="meta" style={{ marginBottom: 0 }}>
          {C.noInvitation}
        </p>
      </div>

      <div className="panel" style={{ marginTop: 24 }}>
        <h2>Boundaries this workspace enforces</h2>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}>
          {/* Boundary copy originates in `@mpc/ui`. If each screen rewords it differently,
              enforcing that copy means nothing. */}
          <li>{REQUIRED_BOUNDARY_COPY.verification}</li>
          <li>{REQUIRED_BOUNDARY_COPY.readiness}</li>
          <li>{REQUIRED_BOUNDARY_COPY.sourceStatus}</li>
          <li>{REQUIRED_BOUNDARY_COPY.proofResult}</li>
        </ul>
      </div>
    </>
  );
}
