import Link from "next/link";
import { ApiError } from "@/lib/api";

/**
 * 오류 표시.
 *
 * 서버가 준 envelope를 그대로 보여준다 — `code`, 재시도 가능 여부, 필요한 역할,
 * access request 경로, correlation ID. §11.7이 요구하는 "Permission: 필요한 role과
 * access request 경로"가 화면까지 도달하는 지점이다.
 *
 * "요청에 실패했습니다"로 뭉개면 사용자는 다음 행동을 알 수 없다.
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

  // 세션이 끝났거나 지갑이 묶이지 않은 것은 고장이 아니라 다음 행동이 정해진 상태다.
  // 서버 문구(한국어 envelope)와 코드 대신 할 일을 말한다.
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
          {/* 실패가 아니라 "그 사이 누가 먼저 바꿨다"는 사실이다. 다시 읽어야 한다. */}
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
