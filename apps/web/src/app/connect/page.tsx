"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";
import { getAuthMethods, startEmailSignIn, verifyEmailSignIn, type AuthMethods } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { explicitNextPath, landingPath } from "@/lib/next-path";
import { useSession } from "@/lib/session";
import { EmailCodeForm } from "@/components/auth/EmailCodeForm";
import { ProviderButtons } from "@/components/auth/ProviderButtons";

const C = AUTH_COPY.signIn;

/**
 * Sign-in — this screen lives at `/connect`, not `/`.
 *
 * While `/` was the sign-in screen, there was no public entry point explaining the product.
 * Sign-in is one branch of the public surface, not its entrance.
 *
 * Account sign-in (WP6): an emailed code, or Google where configured, then the second
 * factor on `/auth/mfa`. No wallet is needed to sign in, and none can be used to: a wallet is a
 * signing key, asked for only when something is signed (WP7 removed the transitional wallet
 * sign-in).
 */
export default function SignInPage() {
  const { session, loading, refresh } = useSession();
  const router = useRouter();
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [methodsFailed, setMethodsFailed] = useState(false);
  const [emailSelected, setEmailSelected] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ at: number; count: number; minutes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadMethods() {
    setMethodsFailed(false);
    void getAuthMethods()
      .then(setMethods)
      .catch(() => setMethodsFailed(true));
  }

  useEffect(loadMethods, []);

  /**
   * Where a fresh session goes: the second factor first, unless it already holds one. Without an
   * asked-for `next`, the landing follows the session's roles (no role: "access pending").
   */
  async function afterSignIn() {
    const next = explicitNextPath();
    const fresh = await refresh();
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

      {!loading && session?.authenticated ? (
        <p className="sub">
          {C.alreadySignedIn} <a href={landingPath(session)}>{C.goToWorkspace}</a>
        </p>
      ) : null}

      <div className="panel" data-testid="email-sign-in">
        <SignInOptions methods={methods} methodsFailed={methodsFailed} emailSelected={emailSelected}
          loadMethods={loadMethods} onSelectEmail={() => setEmailSelected(true)} />
        {methods?.emailCode && (!methods.google || emailSelected) && (sent === null ? (
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
        ))}

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

function SignInOptions({ methods, methodsFailed, emailSelected, loadMethods, onSelectEmail }: {
  methods: AuthMethods | null;
  methodsFailed: boolean;
  emailSelected: boolean;
  loadMethods: () => void;
  onSelectEmail: () => void;
}) {
  return (
    <>
      {methods?.google ? (
        <>
          <ProviderButtons methods={methods} start={{ purpose: "sign_in" }} />
          {!methods.google ? <p className="meta">{C.or}</p> : null}
        </>
      ) : null}
      {!methods && (methodsFailed ? <p role="alert">Could not load sign-in options.{" "}
        <button type="button" onClick={loadMethods}>Try again</button></p> : <p role="status">Loading sign-in options…</p>)}
      {methods?.google && !emailSelected ? (
        <button className="link email-sign-in-option" type="button" onClick={onSelectEmail}>Use an email code instead</button>
      ) : null}
    </>
  );
}
