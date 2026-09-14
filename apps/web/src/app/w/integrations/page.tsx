"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listAuthorities, type AuthorityEntry } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Integrations — spec 11 §11.2.
 *
 * `/w/authorities`가 기관 등록·승인만 덮었다. 그러면 "이 시스템이 지금 무엇에
 * 연결돼 있나"에 답할 자리가 없다 — 기관은 있는데 연동이 꺼져 있거나, 연동은
 * 활성인데 기관이 아직 승인 전인 상태가 보이지 않는다.
 *
 * **연결 성공이 검증이 아니다**(REQUIRED_BOUNDARY_COPY.sourceStatus). 이 화면은
 * 연결 상태만 말하며 그 출처가 옳다는 뜻이 아니다.
 */
export default function IntegrationsPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [authorities, setAuthorities] = useState<AuthorityEntry[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (sessionLoading || !token) return;
    let live = true;
    listAuthorities(token)
      .then((page) => {
        if (live) setAuthorities(page.items);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [token, sessionLoading]);

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

  // 부를 수 있는가로 가른다. `accepted`인데 adapter가 없으면 여전히 못 부른다 —
  // 상태 이름이 아니라 그 사실로 갈라야 화면이 거짓말을 하지 않는다.
  const callable = authorities.filter((entry) => entry.callable);
  const blocked = authorities.filter((entry) => !entry.callable);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <p className="sub">
            Every external party this workspace can reach, and the state of that reach. A successful
            connection is not verification — it means the source answered, not that the answer is
            right.
          </p>
        </div>
        <Link href="/w/authorities">Register an authority →</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel" data-testid="integrations-accepted">
        <h2>Reachable now</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          An authority becomes reachable only after someone other than its registrar accepted it —
          the server refuses a single-person acceptance (02 §2.8) — and after an adapter exists for
          it. Both have to hold.
        </p>
        {callable.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No authority has been accepted yet. Source collection has nothing to call.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Authority</th>
                  <th>Jurisdiction</th>
                  <th>Adapter</th>
                  <th>Recognised scope</th>
                </tr>
              </thead>
              <tbody>
                {callable.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.jurisdiction}</td>
                    <td className="mono">{entry.adapterState}</td>
                    <td style={{ color: "var(--muted-foreground)" }}>
                      {entry.recognizedScope.join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel" data-testid="integrations-pending">
        <h2>Not usable yet</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          These exist but cannot be called. Showing them here rather than hiding them is the point —
          an absent integration and a blocked one look identical from a project screen.
        </p>
        {blocked.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing is waiting.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Authority</th>
                  <th>State</th>
                  <th>Adapter</th>
                  <th>Why not, and what next</th>
                </tr>
              </thead>
              <tbody>
                {blocked.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.name}</td>
                    <td className="mono">{entry.state}</td>
                    <td className="mono">{entry.adapterState}</td>
                    <td style={{ color: "var(--muted-foreground)" }}>
                      {/* 서버가 사유와 다음 행동을 함께 준다. 화면이 추측하지 않는다. */}
                      {entry.adapterStateReason ?? "—"}
                      {entry.nextAction ? <div className="meta">{entry.nextAction}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">No real government source is connected yet</div>
        The adapter framework exists; the endpoints do not. Access to Mongolian institutional
        sources is still being negotiated (OD-42), so every source result you see today comes from a
        synthetic or manual path.
      </div>
    </>
  );
}
