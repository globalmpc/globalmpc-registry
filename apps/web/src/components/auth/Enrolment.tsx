"use client";

import { useState } from "react";
import { confirmTotp, setupTotp, type FactorResult, type MfaStatus } from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { enrolPasskey } from "@/lib/webauthn";
import { TotpQr } from "./TotpQr";

const C = AUTH_COPY.mfa;

/**
 * Adding a second factor: a passkey (offered first — phishing-resistant, and the only factor the
 * high-assurance roles accept) or an authenticator app.
 *
 * What may be added is the server's verdict (`enrolment`), shown as offered or not; the server
 * decides again on the request.
 */
export function Enrolment({
  enrolment,
  onEnrolled,
}: {
  readonly enrolment: MfaStatus["enrolment"];
  readonly onEnrolled: (result: FactorResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [totp, setTotp] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

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
    <div data-testid="enrolment">
      {error ? (
        <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
          {error}
        </div>
      ) : null}

      {enrolment.passkey === "allowed" && totp === null ? (
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(async () => onEnrolled(await enrolPasskey(name.trim() || undefined)));
          }}
        >
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="passkey-name">{C.passkeyName}</label>
            <input id="passkey-name" maxLength={64} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <button className="primary" type="submit" disabled={busy} data-testid="passkey-enrol">
            {busy ? C.passkeyWorking : C.enrolPasskey}
          </button>
        </form>
      ) : null}

      {enrolment.totp === "allowed" ? (
        totp === null ? (
          <p style={{ marginTop: 12 }}>
            <button
              type="button"
              className={enrolment.passkey === "allowed" ? "link" : "primary"}
              disabled={busy}
              data-testid="totp-setup"
              onClick={() =>
                void attempt(async () => {
                  const setup = await setupTotp();
                  setTotp({ otpauthUri: setup.otpauthUri, secret: setup.secret });
                })
              }
            >
              {C.enrolTotp}
            </button>
          </p>
        ) : (
          <form
            style={{ marginTop: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              void attempt(async () => {
                const result = await confirmTotp(code.trim());
                setTotp(null);
                setCode("");
                onEnrolled(result);
              });
            }}
          >
            <p className="sub">{C.totpScan}</p>
            <TotpQr uri={totp.otpauthUri} />
            <p className="meta">
              {C.totpManual} <span className="mono" data-testid="totp-secret">{totp.secret}</span>
            </p>
            <div className="field">
              <label htmlFor="totp-confirm">{C.totpLabel}</label>
              <input
                id="totp-confirm"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              />
            </div>
            <button className="primary" type="submit" disabled={busy || code.length !== 6}>
              {C.totpConfirm}
            </button>
          </form>
        )
      ) : null}
    </div>
  );
}
