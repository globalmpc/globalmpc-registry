"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getMfaStatus,
  regenerateRecoveryCodes,
  removePasskey,
  removeTotp,
  renamePasskey,
  type FactorResult,
  type MfaStatus,
} from "@/lib/account-api";
import { authErrorMessage } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { Enrolment } from "@/components/auth/Enrolment";
import { RecoveryCodes } from "@/components/auth/RecoveryCodes";
import { StepUpCancelled, useStepUp } from "@/components/auth/StepUp";
import { ErrorLine, useAction } from "./useAction";

const C = AUTH_COPY.settings;

/**
 * Passkeys, the authenticator app and recovery codes (WP3).
 *
 * The server decides each step's level: adding a passkey when one exists, removing any factor and
 * regenerating codes all need the strongest factor held (a passkey once one exists). A refusal for
 * the level prompts for that factor and retries (`useAction`). Removing the factor this session
 * proved with ends this session too (`onSessionEnded`); removing another factor ends the other
 * sessions that proved with it, so the session list is read again (`onAccountChanged`).
 */
export function FactorsSection({
  onSessionEnded,
  onAccountChanged,
}: {
  readonly onSessionEnded: () => void;
  /** After any change here (or a step-up): sessions and the session's factors may have changed. */
  readonly onAccountChanged?: () => void;
}) {
  const { refresh } = useSession();
  const { prompt } = useStepUp();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getMfaStatus());
      setLoadError(null);
    } catch (caught) {
      setLoadError(authErrorMessage(caught));
    }
  }, []);
  const changed = useCallback(async () => {
    await load();
    onAccountChanged?.();
  }, [load, onAccountChanged]);
  const { act, busy, error } = useAction(changed);

  useEffect(() => {
    void load();
  }, [load]);

  const removed = (result: { currentSessionEnded: boolean }) => {
    if (result.currentSessionEnded) onSessionEnded();
  };

  async function enrolled(result: FactorResult) {
    setAdding(false);
    if (result.recoveryCodes?.length) setCodes(result.recoveryCodes);
    await refresh();
    await changed();
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  return (
    <div className="panel" data-testid="settings-factors">
      <h2>{C.authenticators}</h2>
      <ErrorLine error={loadError ?? error} />
      {status ? (
        <>
          <h3>{C.passkeys}</h3>
          {status.passkeys.length === 0 ? <p className="meta">{C.noPasskeys}</p> : null}
          <ul data-testid="passkey-list">
            {status.passkeys.map((passkey) => (
              <li key={passkey.id}>
                {renaming?.id === passkey.id ? (
                  <form
                    className="row"
                    style={{ display: "inline-flex" }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void act(async () => {
                        await renamePasskey(passkey.id, renaming.name.trim());
                        setRenaming(null);
                      });
                    }}
                  >
                    <input
                      aria-label={C.rename}
                      maxLength={64}
                      value={renaming.name}
                      onChange={(event) => setRenaming({ id: passkey.id, name: event.target.value })}
                    />
                    <button type="submit" disabled={busy || renaming.name.trim() === ""}>
                      {C.save}
                    </button>
                  </form>
                ) : (
                  <>
                    <span data-testid="passkey-name">{passkey.name}</span>{" "}
                    <span className="meta">
                      · {passkey.lastUsedAt ? C.used(passkey.lastUsedAt.slice(0, 10)) : C.never}
                      {passkey.deviceType === "multiDevice" ? ` · ${C.synced}` : ""}
                    </span>{" "}
                    <button type="button" disabled={busy} onClick={() => setRenaming({ id: passkey.id, name: passkey.name })}>
                      {C.rename}
                    </button>{" "}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(async () => removed(await removePasskey(passkey.id)))}
                    >
                      {C.remove}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>

          <h3>{C.totp}</h3>
          <p className="meta" data-testid="totp-state">
            {status.totpEnrolled ? C.totpOn : C.totpOff}{" "}
            {status.totpEnrolled ? (
              <button type="button" disabled={busy} onClick={() => void act(async () => removed(await removeTotp()))}>
                {C.remove}
              </button>
            ) : null}
          </p>

          {adding ? (
            <Enrolment enrolment={status.enrolment} onEnrolled={(result) => void enrolled(result)} />
          ) : (
            <button
              type="button"
              disabled={busy}
              data-testid="add-factor"
              onClick={() => {
                const verdicts = [status.enrolment.passkey, status.enrolment.totp];
                if (verdicts.includes("allowed")) {
                  setAdding(true);
                  return;
                }
                // Adding needs the strongest factor held first (a passkey once one exists).
                const level = verdicts.includes("MFA_PASSKEY_REQUIRED") ? "aal3" : "aal2";
                void prompt(level)
                  .then(changed)
                  .then(() => setAdding(true))
                  .catch((caught: unknown) => {
                    if (!(caught instanceof StepUpCancelled)) setLoadError(authErrorMessage(caught));
                  });
              }}
            >
              {C.addFactor}
            </button>
          )}

          <h3>{C.recovery}</h3>
          <p className="meta" data-testid="recovery-remaining">
            {status.recoveryCodesRemaining === null
              ? C.recoveryHidden
              : C.recoveryRemaining(status.recoveryCodesRemaining)}
          </p>
          <p className="meta">{C.regenerateWarning}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setCodes((await regenerateRecoveryCodes()).recoveryCodes);
              })
            }
          >
            {C.regenerate}
          </button>
        </>
      ) : null}
    </div>
  );
}
