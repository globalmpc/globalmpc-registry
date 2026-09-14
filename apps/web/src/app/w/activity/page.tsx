"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getMyActivity, type MyActivityItem } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * My Activity.
 *
 * 이 지갑에 묶인 주체가 한 일의 기록이다. **본인만 본다.** tenant 전체 감사
 * 기록(Audit)과 질문이 다르다 — 저쪽은 "여기서 무슨 일이 있었나", 이쪽은 "내가
 * 무엇을 했나"다. 그래서 역할이 없어도 주체가 있으면 열린다.
 */
export default function MyActivityPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [items, setItems] = useState<MyActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (sessionLoading || !token) return;
    let live = true;
    getMyActivity(token)
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [token, sessionLoading]);

  async function loadMore() {
    if (!token || !nextCursor) return;
    try {
      const page = await getMyActivity(token, nextCursor);
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught);
    }
  }

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Activity</h1>
          <p className="sub">
            What this account has done: uploads, claims, reviews, decisions, and votes, newest
            first. Only you see this list. The tenant-wide record is under Audit.
          </p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel" data-testid="my-activity">
        {loaded && items.length === 0 ? (
          <p className="sub" style={{ margin: 0 }} data-testid="my-activity-empty">
            This account has not done anything that is recorded yet. This is not a permission
            problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th>Role</th>
                  <th>Signature or transaction</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="mono meta">{item.occurredAt}</td>
                    <td className="mono">{item.command}</td>
                    <td>
                      {item.projectId ? (
                        <Link href={`/w/projects/${item.projectId}`}>{item.resourceType}</Link>
                      ) : (
                        <span className="mono">{item.resourceType}</span>
                      )}
                    </td>
                    <td className="mono">{item.effectiveRole ?? "—"}</td>
                    <td className="mono" style={{ wordBreak: "break-all" }}>
                      {item.signatureOrTx ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor ? (
          <button style={{ marginTop: 12 }} onClick={() => void loadMore()}>
            Load more
          </button>
        ) : null}
      </div>
    </>
  );
}
