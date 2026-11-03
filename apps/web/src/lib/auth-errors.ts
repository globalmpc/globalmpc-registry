import { ApiError } from "./api";
import { AUTH_COPY } from "./copy";

/**
 * One sentence for an account-flow refusal — never the server's code alone, never a blank.
 *
 * The refusals are generic on purpose (an invitation refusal does not say where an address is
 * used; a code refusal does not say whether the address has an account), and the sentences keep
 * them generic: they say what to do next, not what the server knows.
 */
export function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return AUTH_COPY.errors[error.envelope.code] ?? error.envelope.message ?? error.envelope.code;
  }
  if (error instanceof Error) {
    // The WebAuthn browser API reports a cancelled or timed-out prompt as NotAllowedError.
    if (error.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out. Try again.";
    return error.message;
  }
  return String(error);
}

/** What a refusal asks of the session before the action can succeed. */
export type StepUpNeed =
  /** First factor only: the MFA screen, not a prompt — nothing else is reachable. */
  | { readonly kind: "second_factor" }
  /** Recovery-limited: only re-enrolment. */
  | { readonly kind: "reenrol" }
  /** A stronger factor now, then retry: `aal3` is a passkey, `aal2` a passkey or authenticator code. */
  | { readonly kind: "step_up"; readonly level: "aal2" | "aal3" };

export function stepUpNeed(error: unknown): StepUpNeed | null {
  if (!(error instanceof ApiError)) return null;
  const { code, details } = error.envelope;
  const required = (details as { requiredAal?: unknown } | undefined)?.requiredAal;
  if (code === "MFA_REQUIRED") return { kind: "second_factor" };
  if (code === "MFA_RECOVERY_REENROLMENT_REQUIRED") return { kind: "reenrol" };
  if (code === "MFA_PASSKEY_REQUIRED") return { kind: "step_up", level: "aal3" };
  if (code === "MFA_STEP_UP_REQUIRED") return { kind: "step_up", level: required === "aal3" ? "aal3" : "aal2" };
  if (details?.reason === "AUTHENTICATION_LEVEL_INSUFFICIENT") {
    return { kind: "step_up", level: required === "aal2" ? "aal2" : "aal3" };
  }
  return null;
}
