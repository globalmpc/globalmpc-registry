"use client";

import Link from "next/link";
import { publicDate } from "@/lib/public-date";
import { useEffect, useState } from "react";
import { getMyWork, type MyWork } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { TruncatedNotice } from "@/components/TruncatedNotice";

/**
 * My Work — spec 11 §11.2.
 *
 * **Split the three by meaning.** In one list, "what I must do" and "what I am
 * waiting on" look alike, yet their next actions are opposite.
 *
 * Why the third (unassigned) group exists: if only assigned work is shown, **work nobody
 * owns** is never seen. That is where neglect happens quietly.
 */
export default function MyWorkPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [work, setWork] = useState<MyWork | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (sessionLoading || !token) return;
    let live = true;
    getMyWork(token)
      .then((data) => {
        if (live) setWork(data);
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Work</h1>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {!work && !error ? <p role="status">Loading your work…</p> : null}
      {work ? <>
        <div className="panel" id="assigned-work" data-testid="work-assigned">
          <h2>Assigned to you</h2>
          {work.assignedToMe.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              {work.hasVisibleProjects === false ? <>No projects are available to you yet. <Link href="/w/access-requests">Request access →</Link></>
                : <>No reviews assigned to you. <Link href="/w/projects">View projects →</Link></>}
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>State</th>
                    <th>Next step</th>
                    <th>Conflict</th>
                  </tr>
                </thead>
                <tbody>
                  {work.assignedToMe.map((item) => (
                    <tr key={item.caseId}>
                      <td>
                        {item.projectName}
                      </td>
                      <td className="mono">{item.state}</td>
                      <td><Link href={`/w/projects/${item.projectId}/verification?caseId=${encodeURIComponent(item.caseId)}`}>Open review</Link></td>
                      <td className="mono">
                        {/* An assignment with an unresolved conflict of interest cannot proceed (02 §2.4). */}
                        {item.conflictStatus === "unresolved" ? (
                          <span style={{ color: "var(--destructive-text)" }}>unresolved</span>
                        ) : (
                          item.conflictStatus
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <details className="panel" id="waiting-work" data-testid="work-waiting">
          <summary>Waiting on someone else ({work.waitingOnOthers.length})</summary>

          {work.waitingOnOthers.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              Nothing of yours is waiting on a decision.
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}>
              {work.waitingOnOthers.map((item) => (
                <li key={item.id}>
                  {item.summary} <span className="meta">· since {publicDate(item.since)}</span>
                </li>
              ))}
            </ul>
          )}
        </details>

        <details className="panel" id="unassigned-work" data-testid="work-unassigned">
          <summary>Open and unassigned ({work.unassigned.length}{work.unassignedTruncated ? "+" : ""})</summary>

          {work.unassigned.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              Nothing is open and unassigned.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>What</th>
                    <th>Open since</th>
                  </tr>
                </thead>
                <tbody>
                  {work.unassigned.map((item) => (
                    <tr key={`${item.kind}-${item.id}`}>
                      <td className="mono">{item.kind}</td>
                      <td style={{ color: "var(--muted-foreground)" }}>
                        {item.summary}
                        {item.projectId ? (
                          <>
                            {" "}
                            <Link href={`/w/projects/${item.projectId}`}>project →</Link>
                          </>
                        ) : null}
                      </td>
                      <td className="mono meta">{publicDate(item.since)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {work.unassignedTruncated ? (
            <TruncatedNotice
              shown={work.unassigned.filter((item) => item.kind === "stale_signal").length}
              noun="stale signals, oldest first"
              testId="work-unassigned-truncated"
            />
          ) : null}
        </details>
      </> : null}
    </>
  );
}
