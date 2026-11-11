"use client";

import Link from "next/link";
import { ApiError } from "@/lib/api";
import { stepUpNeed } from "@/lib/auth-errors";
import { AUTH_COPY, COPY } from "@/lib/copy";
import { StepUpCancelled, useOptionalStepUp } from "@/components/auth/StepUp";

/**
 * Error display.
 *
 * Shows the server envelope as-is — `code`, whether retry is possible, the required role,
 * the access request path, and the correlation ID. This is where §11.7 "Permission: the required role and
 * the access request path" reaches the screen.
 *
 * Flattening it into "The request failed" leaves the user with no next action.
 *
 * `context` names the flow the error came from when one code means different things in different
 * flows: `SIGNATURE_SIGNER_MISMATCH` is "not the wallet being bound" while binding, but "not your
 * signing wallet" when an attestation or a gate decision is signed.
 */
export function ErrorNotice({ error, context }: { error: unknown; context?: "signing" }) {
  const stepUp = useOptionalStepUp();
  if (!(error instanceof ApiError)) {
    return (
      <div className="notice" style={{ color: "var(--destructive-text)" }} role="alert" data-testid="error-notice">
        <div className="title">Unexpected error</div>
        <div>{error instanceof Error ? error.message : String(error)}</div>
      </div>
    );
  }

  const { envelope, status } = error;

  // An ended session or an unbound wallet is not a failure; it is a state with a defined next action.
  // State what to do instead of the server wording (the envelope message) and the code.
  if (envelope.code === "UNAUTHENTICATED") {
    return (
      <div className="notice" style={{ color: "var(--alert)" }} role="alert" data-testid="error-notice">
        <div className="title">Your session has ended</div>
        Sessions last eight hours, end after 30 minutes without use, and signing out ends them.{" "}
        <Link href="/connect">Sign in again →</Link>
      </div>
    );
  }

  /**
   * The session's level is below what this action needs (plan §3 rules 2 and 4). Not a missing
   * role: the person holds it and proves a stronger factor — then the screen is read again.
   */
  const need = stepUpNeed(error);
  if (need) {
    return renderStepUp(need);
  }

  /**
   * Identity assurance below the role's minimum (plan priority rule 4): the person holds the role
   * but an administrator has to verify their identity first — say that, not a refusal code.
   */
  if (envelope.details?.reason === "ASSURANCE_LEVEL_INSUFFICIENT") {
    return (
      <div className="notice" style={{ color: "var(--alert)" }} role="alert" data-testid="error-notice">
        <div className="title" data-testid="assurance-needed">
          {COPY.assurance.heading}
        </div>
        <div>{COPY.assurance.lead(envelope.details.requiredAssurance ?? "high_assurance")}</div>
        <div className="meta" style={{ marginTop: 8, color: "inherit" }}>
          <span className="mono">
            ({status} {envelope.details.reason})
          </span>{" "}
          · Trace ID <span className="mono">{envelope.correlationId}</span>
        </div>
      </div>
    );
  }

  function renderStepUp(need: NonNullable<ReturnType<typeof stepUpNeed>>) {
    return (
      <div className="notice" style={{ color: "var(--alert)" }} role="alert" data-testid="error-notice">
        <div className="title">{AUTH_COPY.stepUp.heading}</div>
        {need.kind === "step_up" ? (
          <>
            {need.level === "aal3" ? AUTH_COPY.stepUp.passkeyLead : AUTH_COPY.stepUp.factorLead}{" "}
            {stepUp ? (
              <button
                type="button"
                onClick={() =>
                  void stepUp
                    .prompt(need.level)
                    .then(() => window.location.reload())
                    .catch((caught: unknown) => {
                      if (!(caught instanceof StepUpCancelled)) throw caught;
                    })
                }
              >
                {AUTH_COPY.stepUp.errorAction}
              </button>
            ) : null}
          </>
        ) : (
          <Link href="/auth/mfa">{AUTH_COPY.mfa.heading} →</Link>
        )}
      </div>
    );
  }

  const friendly =
    (context === "signing" ? COPY.signing[envelope.code] : undefined) ?? AUTH_COPY.errors[envelope.code];

  const tone = status === 403 || status === 401 ? "var(--alert)" : "var(--destructive-text)";

  return (
    <div className="notice" style={{ color: tone }} role="alert" data-testid="error-notice">
      <div className="title">
        {friendly ?? envelope.message}{" "}
        <span className="mono meta" style={{ color: "inherit" }}>
          ({status} {envelope.code})
        </span>
      </div>

      <ErrorDetails envelope={envelope} />

      <div className="meta" style={{ marginTop: 8, color: "inherit" }}>
        {envelope.retryable
          ? "This error can be retried."
          : "Retrying will produce the same result."}{" "}
        · Trace ID <span className="mono">{envelope.correlationId}</span>
      </div>
    </div>
  );
}

function ErrorDetails({ envelope }: { envelope: ApiError["envelope"] }) {
  return <>
      {envelope.details?.reason ? (
        <div className="meta" style={{ color: "inherit" }}>
          Reason: <span className="mono">{envelope.details.reason}</span>
        </div>
      ) : null}

      {envelope.details?.requiredRoles ? (
        <div>
          One of these roles is required:
          <ul>
            {envelope.details.requiredRoles.map((role) => (
              <li key={role} className="mono">
                {role}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {envelope.details?.currentVersion ? (
        <div className="meta" style={{ color: "inherit" }}>
          {/* Not a failure but the fact that "someone changed it first in the meantime". Re-read. */}
          You were looking at <span className="mono">v{envelope.details.expectedVersion}</span>;
          the current version is <span className="mono">v{envelope.details.currentVersion}</span> —
          read it again before deciding.
        </div>
      ) : null}

      {envelope.details?.restrictionId ? (
        <div className="meta" style={{ color: "inherit" }}>
          {/* The same ID the blackout notice shows. There is no way around it before release. */}
          Restriction ID: <span className="mono">{envelope.details.restrictionId}</span>
        </div>
      ) : null}

      {envelope.details?.hint ? (
        <div className="meta" style={{ color: "inherit" }}>
          {envelope.details.hint}
        </div>
      ) : null}

      {envelope.details?.requiredAssurance ? (
        <div>
          Required identity assurance:{" "}
          <span className="mono">{envelope.details.requiredAssurance}</span>
        </div>
      ) : null}

      {envelope.details?.accessRequestPath ? (
        <div style={{ marginTop: 6 }}>
          <Link href={envelope.details.accessRequestPath}>Request access →</Link>
        </div>
      ) : null}

  </>;
}
