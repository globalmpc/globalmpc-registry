"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  getOutboxBacklog,
  listAuditEvents,
  type AuditEvent,
  type OutboxBacklog,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Address } from "@/components/Address";

/**
 * 감사 로그와 이벤트 발행 상태 — spec 02 §2.6, 07 §7.5.
 *
 * `audit.events`가 append-only이고 superuser도 수정할 수 없다는 보장은, 읽는
 * 경로가 없으면 운영에 쓰이지 못한다. DB에 직접 붙어야만 볼 수 있는 감사 기록은
 * 감사의 신뢰를 오히려 떨어뜨린다.
 *
 * **`detail`은 표시하지 않는다.** 이벤트 payload에 PII를 넣지 않기로 했지만,
 * 약속이 깨졌을 때 이 화면이 최초 유출 경로가 된다. 무엇이 일어났는지는
 * command와 resource로 충분하다.
 */
export default function AuditPage() {
  const { token, loading: sessionLoading } = useSession();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [backlog, setBacklog] = useState<OutboxBacklog | null>(null);
  const [resourceType, setResourceType] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [eventData, backlogData] = await Promise.all([
        listAuditEvents(token, resourceType ? { resourceType } : {}),
        getOutboxBacklog(token),
      ]);
      setEvents(eventData.items);
      setBacklog(backlogData);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [token, resourceType]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

  if (!sessionLoading && !token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="sub">
            Who did what, and when. These records are never edited or deleted — a trigger
            refuses it.
          </p>
        </div>
        <Link href="/w/projects">← Projects</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {backlog ? (
        <div className="panel" data-testid="outbox-backlog">
          <h2>Event publication</h2>
          <dl className="dl">
            <dt>Unpublished</dt>
            <dd className="mono" data-testid="backlog-pending">
              {backlog.pending}
              {backlog.pending > 0 ? (
                // at-least-once다. 쌓인다는 것은 사라졌다는 뜻이 아니라 늦어진다는
                // 뜻이다 — 그 구분이 대응을 정한다.
                <span className="meta"> · delayed, not lost</span>
              ) : null}
            </dd>
            <dt>Oldest delay</dt>
            <dd className="mono">
              {backlog.oldestPendingAgeSeconds === null
                ? "—"
                : `${backlog.oldestPendingAgeSeconds}s`}
            </dd>
            <dt>Published in the last hour</dt>
            <dd className="mono">{backlog.publishedLastHour}</dd>
          </dl>

          {backlog.byEventType.length > 0 ? (
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--muted-foreground)" }}>
              {backlog.byEventType.map((row) => (
                <li key={row.eventType}>
                  <span className="mono">{row.eventType}</span> — {row.pending}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="meta" style={{ marginTop: 10 }}>
            {/* 수동 재생성이 진짜 중복을 만든다. */}
            The delay matters more than the count. A thousand events one second late and one
            event an hour late are different problems.
          </p>
        </div>
      ) : null}

      <div className="panel">
        <div className="field">
          <label htmlFor="resourceType">Narrow by resource type</label>
          <input
            id="resourceType"
            className="mono"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value)}
            placeholder="verification_case"
          />
        </div>
        <button onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Search"}
        </button>
      </div>

      <div className="panel">
        {events.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No matching records. There is no data here; this is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table data-testid="audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>command</th>
                  <th>resource</th>
                  <th>Actor</th>
                  <th>Role</th>
                  <th>Version</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="mono meta">{event.occurredAt.slice(0, 19).replace("T", " ")}</td>
                    <td className="mono">{event.command}</td>
                    <td className="mono meta">
                      {event.resourceType}
                      {event.resourceId ? (
                        <div className="meta">{event.resourceId.slice(0, 8)}…</div>
                      ) : null}
                    </td>
                    <td className="mono meta">
                      {event.actorWallet ? <Address value={event.actorWallet} /> : "—"}
                    </td>
                    <td className="mono meta">{event.effectiveRole ?? "—"}</td>
                    <td className="mono meta">
                      {event.beforeVersion !== null || event.afterVersion !== null
                        ? `${event.beforeVersion ?? "—"} → ${event.afterVersion ?? "—"}`
                        : "—"}
                    </td>
                    <td className="meta">{event.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">What this screen does not show</div>
        The detailed payload of each event is not shown. The command and the resource say what
        happened, and exposing the detail would make this screen a channel for sensitive data.
      </div>
    </>
  );
}
