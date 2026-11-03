"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getAuthMethods, startEmailChangeVerification, verifyEmailChange } from "@/lib/account-api";
import { AUTH_COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { EmailCodeForm } from "@/components/auth/EmailCodeForm";

const C = AUTH_COPY.emailChange;

/**
 * Completing an approved email change — journey 7.
 *
 * Two administrators approved the move; the code went to the new address, so entering it proves
 * the person reads that mailbox. Completing it ends every session of the account, and the person
 * signs in again with the new address. No session is needed here: the old one may be gone already.
 */
export default function EmailChangePage() {
  const { signOut } = useSession();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ at: number; count: number; minutes: number } | null>(null);
  const [done, setDone] = useState(false);
  // The approval mailed the first code; a new one may be asked for after the usual wait.
  const [openedAt] = useState(() => Date.now());
  const [digits, setDigits] = useState(8);

  useEffect(() => {
    getAuthMethods()
      .then((methods) => setDigits(methods.emailCodeDigits))
      .catch(() => undefined);
  }, []);

  async function send() {
    const answer = await startEmailChangeVerification(email.trim());
    setSent((previous) => ({ at: Date.now(), count: (previous?.count ?? 0) + 1, minutes: answer.expiresInMinutes }));
  }

  if (done) {
    return (
      <div className="panel" data-testid="email-change-done">
        <p className="sub">{C.done}</p>
        <Link href="/connect" className="btn-connect">
          {AUTH_COPY.mfa.signInAgain}
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{C.heading}</h1>
          <p className="sub">{C.lead}</p>
        </div>
      </div>
      <div className="panel">
        <div className="field">
          <label htmlFor="new-email">{AUTH_COPY.admin.newEmail}</label>
          <input
            id="new-email"
            type="email"
            autoComplete="email"
            value={email}
            disabled={sent !== null}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <EmailCodeForm
          digits={digits}
          expiresInMinutes={sent?.minutes ?? null}
          sentAt={sent?.at ?? openedAt}
          sends={sent?.count ?? 1}
          submitLabel={C.confirm}
          onResend={send}
          onSubmit={async (code) => {
            await verifyEmailChange(email.trim(), code);
            await signOut();
            setDone(true);
          }}
        />
      </div>
    </>
  );
}
