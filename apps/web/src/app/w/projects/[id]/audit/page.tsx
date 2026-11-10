"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { listAuditEvents, type AuditEvent } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

export default function ProjectAuditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { token, session } = useSession();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const allowed = session?.actions?.includes("audit.read") === true;
  useEffect(() => {
    if (!allowed || !token) return;
    let live = true;
    setEvents(null);
    setError(null);
    listAuditEvents(token, { projectId: id })
      .then((result) => {
        if (live) setEvents(result.items);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [id, token, allowed]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Project audit trail</h1>
          <p className="sub">
            Recorded actions for this project. Earlier events remain in the
            append-only audit record.
          </p>
        </div>
      </div>
      {!allowed ? (
        <p className="notice">
          Audit access is required.{" "}
          <Link href={`/w/projects/${id}/access-requests`}>
            Request access →
          </Link>
        </p>
      ) : error ? (
        <ErrorNotice error={error} />
      ) : !events ? (
        <p role="status">Loading project audit…</p>
      ) : events.length === 0 ? (
        <p className="sub">No audit events returned for this project.</p>
      ) : (
        <ol className="audit-timeline">
          {events.map((event) => (
            <li key={event.id}>
              <p className="meta">{event.occurredAt}</p>
              <strong>{event.command.replaceAll(".", " · ")}</strong>
              <p>
                {event.effectiveRole?.replaceAll("_", " ") ?? "Role not recorded"} ·{" "}
                {event.resourceType}
              </p>
              <p className="meta">
                {event.beforeVersion === null
                  ? "No previous version"
                  : `v${event.beforeVersion}`}{" "}
                →{" "}
                {event.afterVersion === null
                  ? "No resulting version"
                  : `v${event.afterVersion}`}
              </p>
            </li>
          ))}
        </ol>
      )}
      <p className="meta">
        This view shows the events returned by the API, not a count of the full
        history.
      </p>
    </>
  );
}
