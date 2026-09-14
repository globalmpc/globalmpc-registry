"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  listNotifications,
  markNotificationRead,
  newIdempotencyKey,
  type Notification,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * 알림 — spec 12 §12.4.
 *
 * 검토 요청·gap·stale·revoke가 일어나도 당사자가 아는 경로는 화면을 다시 여는
 * 것뿐이었다. 그것은 "무엇이 바뀌었나"에 답하지 않는다 — 사람이 화면마다 이전
 * 상태를 기억하고 있어야 한다.
 *
 * **읽음은 나에 대해서만이다.** 역할로 온 알림을 내가 읽었다고 남에게서 지우면,
 * 내가 처리하지 않았을 때 아무도 다시 보지 않는다. 화면이 그 사실을 밝힌다.
 *
 * **여기 있는 것이 전부는 아니다.** 메일·webhook으로 내보내는 경로는 정해진 바
 * 없다. 앱을 열지 않으면 여전히 모른다 — 화면이 그것을 숨기지 않는다.
 */

const KIND_LABEL: Record<Notification["kind"], string> = {
  review_assigned: "Review assigned",
  readiness_gap: "Readiness gap",
  evidence_stale: "Evidence shaken",
  registry_revoked: "Record revoked",
};

export default function NotificationsPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      setItems((await listNotifications(token)).items);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [token]);

  useEffect(() => {
    if (sessionLoading) return;
    void reload();
  }, [reload, sessionLoading]);

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

  const unread = items.filter((item) => !item.read);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="sub">
            What changed that you would otherwise have to notice by reopening a screen. {unread.length}{" "}
            unread.
          </p>
        </div>
      </div>

      <div className="notice" style={{ color: "var(--alert)" }} data-testid="notifications-limits">
        <div className="title">Nothing is sent anywhere yet</div>
        These reach you only when you open this page. No email, webhook, or push delivery has been
        decided, so an urgent item still waits until someone looks. Marking one read applies to you
        alone — an item addressed to a role stays unread for everyone else who holds it.
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel">
        {items.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing has happened that concerns you. This is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table data-testid="notifications-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Addressed to</th>
                  <th>When</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} style={{ opacity: item.read ? 0.55 : 1 }}>
                    <td>
                      <Link href={item.link}>{KIND_LABEL[item.kind]}</Link>
                      <div className="meta">{item.summary}</div>
                    </td>
                    <td className="mono">
                      {item.audience === "you" ? "you" : item.audienceRole}
                      {item.audience === "role" ? (
                        <div className="meta">shared with everyone in this role</div>
                      ) : null}
                    </td>
                    <td className="mono meta">{item.occurredAt}</td>
                    <td>
                      {item.read ? (
                        <span className="meta">read by you</span>
                      ) : (
                        <button
                          onClick={() => {
                            void markNotificationRead(token!, newIdempotencyKey(), item.id).then(
                              () => reload(),
                            );
                          }}
                        >
                          Mark read
                        </button>
                      )}
                    </td>
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
