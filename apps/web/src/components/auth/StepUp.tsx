"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getMfaStatus, type MfaStatus } from "@/lib/account-api";
import { authErrorMessage, stepUpNeed } from "@/lib/auth-errors";
import { AUTH_COPY } from "@/lib/copy";
import { useSession } from "@/lib/session";
import { SecondFactorChallenge } from "./SecondFactor";

const C = AUTH_COPY.stepUp;

/** The person closed the prompt. Not a failure: the action simply did not happen. */
export class StepUpCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "StepUpCancelled";
  }
}

interface StepUpValue {
  /** Ask for a factor at `level` now; resolves once the session has it. */
  prompt(level: "aal2" | "aal3"): Promise<void>;
  /**
   * Runs `action`; if the server answers that the session's level is too low
   * (`MFA_STEP_UP_REQUIRED`, `MFA_PASSKEY_REQUIRED`, `AUTHENTICATION_LEVEL_INSUFFICIENT`), asks for
   * the factor and runs it once more. Any other refusal — and a second one — is thrown as is.
   */
  run<T>(action: () => Promise<T>): Promise<T>;
}

const StepUpContext = createContext<StepUpValue | null>(null);

interface Pending {
  readonly level: "aal2" | "aal3";
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export function StepUpProvider({ children }: { readonly children: React.ReactNode }) {
  const { refresh } = useSession();
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const prompt = useCallback(
    (level: "aal2" | "aal3") =>
      new Promise<void>((resolve, reject) => {
        // One prompt at a time; a second request joins the reason the first was raised for.
        pendingRef.current?.reject(new StepUpCancelled());
        const next = { level, resolve, reject };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (caught) {
        const need = stepUpNeed(caught);
        if (!need) throw caught;
        if (need.kind !== "step_up") {
          // A first-factor or recovery session has one place to go; a prompt here could not help.
          router.push("/auth/mfa");
          throw caught;
        }
        await prompt(need.level);
        return action();
      }
    },
    [prompt, router],
  );

  const settle = useCallback((outcome: "proved" | "cancelled") => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (!current) return;
    if (outcome === "proved") current.resolve();
    else current.reject(new StepUpCancelled());
  }, []);

  return (
    <StepUpContext.Provider value={{ prompt, run }}>
      {children}
      {pending ? (
        <StepUpDialog
          level={pending.level}
          onCancel={() => settle("cancelled")}
          onProved={async () => {
            await refresh();
            settle("proved");
          }}
        />
      ) : null}
    </StepUpContext.Provider>
  );
}

function StepUpDialog({
  level,
  onCancel,
  onProved,
}: {
  readonly level: "aal2" | "aal3";
  readonly onCancel: () => void;
  readonly onProved: () => Promise<void>;
}) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMfaStatus()
      .then(setStatus)
      .catch((caught: unknown) => setError(authErrorMessage(caught)));
  }, []);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="step-up-heading">
      <div className="panel" data-testid="step-up">
        <h2 id="step-up-heading">{C.heading}</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {level === "aal3" ? C.passkeyLead : C.factorLead}
        </p>
        {error ? (
          <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert">
            {error}
          </div>
        ) : null}
        {status && level === "aal3" && !status.passkeyEnrolled ? (
          <p className="meta" data-testid="step-up-no-passkey">
            {C.noPasskey} <a href="/w/settings">{AUTH_COPY.settings.navLabel} →</a>
          </p>
        ) : status ? (
          <SecondFactorChallenge
            status={status}
            level={level}
            allowRecovery={false}
            onProved={() => void onProved()}
          />
        ) : null}
        <p style={{ marginTop: 16, marginBottom: 0 }}>
          <button type="button" onClick={onCancel}>
            {C.cancel}
          </button>
        </p>
      </div>
    </div>
  );
}

export function useStepUp(): StepUpValue {
  const value = useContext(StepUpContext);
  if (!value) throw new Error("useStepUp can only be used inside StepUpProvider");
  return value;
}

/** For components that may render outside the provider (unit tests of a single screen). */
export function useOptionalStepUp(): StepUpValue | null {
  return useContext(StepUpContext);
}
