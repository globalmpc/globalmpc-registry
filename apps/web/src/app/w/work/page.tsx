"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getMyWork, type MyWork } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * My Work — spec 11 §11.2.
 *
 * **셋을 의미로 갈라 낸다.** 한 목록에 섞으면 "내가 해야 하는 것"과 "내가
 * 기다리는 것"이 같아 보이고, 그 둘은 다음 행동이 정반대다.
 *
 * 세 번째(아무에게도 배정되지 않은 것)가 있는 이유: 배정된 일만 보이면 **아무도
 * 맡지 않은 일**이 영원히 보이지 않는다. 방치가 조용히 일어나는 자리다.
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
          <p className="sub">
            What is waiting on you, what you are waiting on, and what nobody has picked up. Those
            three call for different next steps, so they are not one list.
          </p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel" data-testid="work-assigned">
        <h2>Assigned to you</h2>
        {work && work.assignedToMe.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing is assigned to you. This is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>State</th>
                  <th>Assigned</th>
                  <th>Conflict</th>
                </tr>
              </thead>
              <tbody>
                {work?.assignedToMe.map((item) => (
                  <tr key={item.caseId}>
                    <td>
                      <Link href={`/w/projects/${item.projectId}/verification`}>
                        {item.projectName}
                      </Link>
                    </td>
                    <td className="mono">{item.state}</td>
                    <td className="mono meta">{item.assignedAt}</td>
                    <td className="mono">
                      {/* 이해상충이 해소되지 않은 배정은 진행할 수 없다(02 §2.4). */}
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

      <div className="panel" data-testid="work-waiting">
        <h2>Waiting on someone else</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          You started these. There is nothing for you to do until another person decides.
        </p>
        {work && work.waitingOnOthers.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing of yours is waiting on a decision.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}>
            {work?.waitingOnOthers.map((item) => (
              <li key={item.id}>
                {item.summary} <span className="meta">· since {item.since}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel" data-testid="work-unassigned">
        <h2>Open and unassigned</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Nobody has picked these up. They are here because a queue that shows only assigned work
          hides exactly the items that get forgotten.
        </p>
        {work && work.unassigned.length === 0 ? (
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
                {work?.unassigned.map((item) => (
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
                    <td className="mono meta">{item.since}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
