"use client";

import { useState } from "react";
import { redeemRecoveryCode, verifyTotp, type FactorResult, type MfaStatus } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { provePasskey } from "@/lib/webauthn";

const C = AUTH_COPY.mfa;

/**
 * Proving a second factor the account already holds — sign-in (aal1 → aal2/aal3) and step-up.
 *
 * `level: "aal3"` offers only the passkey: an authenticator code cannot reach a passkey-only role,
 * and offering it would end in a refusal. A recovery code is offered only where the server accepts
 * one — from a first-factor session (`allowRecovery`).
 */
export function SecondFactorChallenge({
  status,
  level = "aal2",
  allowRecovery,
  onProved,
  onRecovered,
}: {
  readonly status: Pick<MfaStatus, "passkeyEnrolled" | "totpEnrolled">;
  readonly level?: "aal2" | "aal3";
  readonly allowRecovery: boolean;
  readonly onProved: (result: FactorResult) => void;
  readonly onRecovered?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string | null>(null);

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

  const offerTotp = status.totpEnrolled && level !== "aal3";

  return (
    <div data-testid="second-factor">
      {error ? (
        <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
          {error}
        </div>
      ) : null}

      {status.passkeyEnrolled ? (
        <button
          className="primary"
          type="button"
          disabled={busy}
          data-testid="passkey-prove"
          onClick={() => void attempt(async () => onProved(await provePasskey()))}
        >
          {busy ? C.passkeyWorking : C.passkey}
        </button>
      ) : null}

      {offerTotp ? (
        <form
          className="row"
          style={{ alignItems: "flex-end", marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(async () => {
              const result = await verifyTotp(code.trim());
              setCode("");
              onProved(result);
            });
          }}
        >
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="totp-code">{C.totpLabel}</label>
            <input
              id="totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </div>
          <button type="submit" disabled={busy || code.length !== 6}>
            {C.totpSubmit}
          </button>
        </form>
      ) : null}

      {allowRecovery ? (
        recovery === null ? (
          <p className="meta" style={{ marginTop: 12 }}>
            <button type="button" className="link" onClick={() => setRecovery("")}>
              {C.useRecovery}
            </button>
          </p>
        ) : (
          <form
            style={{ marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              void attempt(async () => {
                await redeemRecoveryCode(recovery.trim());
                onRecovered?.();
              });
            }}
          >
            <p className="meta">{C.recoveryWarning}</p>
            <div className="field">
              <label htmlFor="recovery-code">{C.recoveryLabel}</label>
              <input
                id="recovery-code"
                autoComplete="off"
                value={recovery}
                onChange={(event) => setRecovery(event.target.value)}
              />
            </div>
            <button type="submit" disabled={busy || recovery.trim() === ""}>
              {C.recoverySubmit}
            </button>
          </form>
        )
      ) : null}
    </div>
  );
}
