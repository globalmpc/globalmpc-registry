import Link from "next/link";
import { ApiError } from "@/lib/api";

/**
 * Error display.
 *
 * Shows the server envelope as-is — `code`, whether retry is possible, the required role,
 * the access request path, and the correlation ID. This is where §11.7 "Permission: the required role and
 * the access request path" reaches the screen.
 *
 * Flattening it into "The request failed" leaves the user with no next action.
 */
export function ErrorNotice({ error }: { error: unknown }) {
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
        Sessions last eight hours, and disconnecting ends them.{" "}
        <Link href="/connect">Connect your wallet again →</Link>
      </div>
    );
  }
  if (envelope.code === "WALLET_NOT_ENROLLED") {
    return (
      <div className="notice" style={{ color: "var(--alert)" }} role="alert" data-testid="error-notice">
        <div className="title">This wallet is not linked to a workspace yet</div>
        An operator must link it to your organization first. Signing in again will not change this.
      </div>
    );
  }

  const tone = status === 403 || status === 401 ? "var(--alert)" : "var(--destructive-text)";

  return (
    <div className="notice" style={{ color: tone }} role="alert" data-testid="error-notice">
      <div className="title">
        {envelope.message}{" "}
        <span className="mono meta" style={{ color: "inherit" }}>
          ({status} {envelope.code})
        </span>
      </div>

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

      <div className="meta" style={{ marginTop: 8, color: "inherit" }}>
        {envelope.retryable
          ? "This error can be retried."
          : "Retrying will produce the same result."}{" "}
        · Trace ID <span className="mono">{envelope.correlationId}</span>
      </div>
    </div>
  );
}
