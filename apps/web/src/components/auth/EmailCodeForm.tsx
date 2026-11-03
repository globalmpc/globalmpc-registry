"use client";

import { useEffect, useState } from "react";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";

const C = AUTH_COPY.signIn;

/** Seconds before each further "send a new code": 30 s, then 60, 120, capped at 5 minutes. */
export function resendDelaySeconds(sent: number): number {
  return Math.min(300, 30 * 2 ** Math.max(0, sent - 1));
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The code step shared by sign-in, invitation acceptance and email change: enter the emailed code,
 * see how long it lives, ask for another one with a growing wait.
 *
 * The wait is a courtesy, not a control — the server limits codes per address and per IP. It keeps
 * a person from burning that budget with repeated clicks while a mail is still on its way.
 */
export function EmailCodeForm({
  digits,
  expiresInMinutes,
  sentAt,
  sends,
  onResend,
  onSubmit,
  children,
  submitLabel = C.verify,
}: {
  readonly digits: number;
  /** Null when this page did not ask for the code itself (its expiry is not known here). */
  readonly expiresInMinutes: number | null;
  /** When the last code was asked for (ms). */
  readonly sentAt: number;
  /** How many codes have been asked for so far. */
  readonly sends: number;
  readonly onResend: () => Promise<void>;
  readonly onSubmit: (code: string) => Promise<void>;
  readonly children?: React.ReactNode;
  readonly submitLabel?: string;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = expiresInMinutes === null ? null : sentAt + expiresInMinutes * 60_000 - now;
  const resendAt = sentAt + resendDelaySeconds(sends) * 1000;
  const resendWait = Math.max(0, Math.ceil((resendAt - now) / 1000));

  async function attempt(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      data-testid="code-form"
      onSubmit={(event) => {
        event.preventDefault();
        void attempt(() => onSubmit(code));
      }}
    >
      {error ? (
        <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
          {error}
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="email-code">{C.codeLabel(digits)}</label>
        <input
          id="email-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={digits}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
        />
        {remaining === null ? null : (
          <p className="meta" data-testid="code-expiry">
            {remaining > 0 ? C.expiresIn(formatRemaining(remaining)) : C.expired}
          </p>
        )}
      </div>
      {children}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || code.length !== digits}>
          {busy ? C.verifying : submitLabel}
        </button>
        <button
          type="button"
          disabled={busy || resendWait > 0}
          onClick={() =>
            void attempt(async () => {
              await onResend();
              setCode("");
            })
          }
        >
          {resendWait > 0 ? C.resendIn(resendWait) : C.resend}
        </button>
      </div>
    </form>
  );
}
