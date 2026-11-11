"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getMfaStatus, type FactorResult, type MfaStatus } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { currentLandingPath } from "@/lib/next-path";
import { needsSecondFactor, useSession } from "@/lib/session";
import { Enrolment } from "@/components/auth/Enrolment";
import { RecoveryCodes } from "@/components/auth/RecoveryCodes";
import { SecondFactorChallenge } from "@/components/auth/SecondFactor";

const C = AUTH_COPY.mfa;

/**
 * The step after the first factor (plan §3, priority rule 2).
 *
 * A first-factor (`aal1`) session reaches nothing but this. Which screen it sees follows the
 * server's MFA status:
 *
 * 1. recovery-limited (a recovery code was used) → re-enrolment only; proving the new factor ends
 *    every session, this one included, and the person signs in again (journey 5);
 * 2. holds a passkey or authenticator app → prove one (or use a recovery code);
 * 3. holds none and may enrol (the 24 h window after an invitation or reset) → passkey first, or an
 *    authenticator app, then the recovery codes once;
 * 4. holds none and may not → ask an administrator for an MFA reset.
 */
export default function SecondFactorPage() {
  const { session, loading, refresh, signOut } = useSession();
  const router = useRouter();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [recoveryDone, setRecoveryDone] = useState(false);

  const load = useCallback(() => {
    getMfaStatus()
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((caught: unknown) => setError(authErrorMessage(caught)));
  }, []);

  useEffect(() => {
    if (loading || !session?.authenticated) return;
    if (!needsSecondFactor(session)) {
      // Already past this step (a reload): nothing to do here.
      if (codes === null && !recoveryDone) router.replace(currentLandingPath(session));
      return;
    }
    load();
  }, [loading, session, load, router, codes, recoveryDone]);

  async function proved(result: FactorResult) {
    if (result.sessionEnded) {
      // Recovery complete: the server ended this session too. Clear the cookie and say so.
      setRecoveryDone(true);
      await signOut();
      return;
    }
    if (result.recoveryCodes && result.recoveryCodes.length > 0) {
      setCodes(result.recoveryCodes);
      await refresh();
      return;
    }
    router.replace(currentLandingPath(await refresh()));
  }

  if (recoveryDone) {
    return (
      <div className="panel" data-testid="recovery-complete">
        <h1>{C.reenrolHeading}</h1>
        <p className="sub">{C.recoveryDone}</p>
        <Link href="/connect" className="btn-connect">
          {C.signInAgain}
        </Link>
      </div>
    );
  }

  if (codes) {
    return <RecoveryCodes codes={codes} onDone={() => router.replace(currentLandingPath(session))} />;
  }

  if (loading) return <p className="sub">Loading your session…</p>;

  if (!session?.authenticated) {
    return (
      <div className="panel">
        <p className="sub">{AUTH_COPY.signIn.lead}</p>
        <Link href="/connect" className="btn-connect">
          {AUTH_COPY.signIn.heading} →
        </Link>
      </div>
    );
  }

  function renderFactorStatus() {
    const holdsFactor = Boolean(status && (status.passkeyEnrolled || status.totpEnrolled));
    const mayEnrol = Boolean(
      status && (status.enrolment.passkey === "allowed" || status.enrolment.totp === "allowed"),
    );

    return (
      <>
        <div className="page-head">
          <div>
            <h1>{status?.recoveryLimited ? C.reenrolHeading : holdsFactor ? C.heading : C.enrolHeading}</h1>
            <p className="sub">
              {status?.recoveryLimited ? C.reenrolLead : holdsFactor ? C.challengeLead : C.enrolLead}
            </p>
          </div>
        </div>

        {error ? (
          <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
            {error}
          </div>
        ) : null}

        {status === null ? null : status.recoveryLimited ? (
          <div className="panel" data-testid="mfa-reenrol">
            {mayEnrol ? <Enrolment enrolment={status.enrolment} onEnrolled={(result) => void proved(result)} /> : null}
          </div>
        ) : holdsFactor ? (
          <div className="panel" data-testid="mfa-challenge">
            <SecondFactorChallenge
              status={status}
              allowRecovery
              onProved={(result) => void proved(result)}
              onRecovered={() => {
                void refresh().then(load);
              }}
            />
          </div>
        ) : mayEnrol ? (
          <div className="panel" data-testid="mfa-enrol">
            <Enrolment enrolment={status.enrolment} onEnrolled={(result) => void proved(result)} />
          </div>
        ) : (
          <div className="notice" style={{ color: "var(--alert)" }} data-testid="mfa-window-closed">
            <div className="title">{C.windowClosedHeading}</div>
            {C.windowClosed}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {renderFactorStatus()}

      <p className="meta">
        <button type="button" className="link" onClick={() => void signOut().then(() => router.push("/connect"))}>
          {C.signOut}
        </button>
      </p>
    </>
  );
}
