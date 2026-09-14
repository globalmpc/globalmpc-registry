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
 * Audit log and event outbox state — spec 02 §2.6, 07 §7.5.
 *
 * The guarantee that `audit.events` is append-only and unmodifiable even by superuser is useless
 * in operation without a read path. An audit record visible only through a direct DB connection
 * undermines trust in the audit instead.
 *
 * **`detail` is not displayed.** Event payloads are meant to carry no PII, but if that
 * promise breaks this screen becomes the first leak path. Command and resource
 * are enough to say what happened.
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
                // Delivery is at-least-once. A backlog means delayed, not
                // lost — that distinction decides the response.
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
            {/* Manual regeneration creates real duplicates. */}
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
