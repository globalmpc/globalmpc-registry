"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  listPublicDisclosures,
  type PublicDisclosureEvent,
  type PublicDisclosureList,
} from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Disclosures & Incidents — spec 11 §11.3.
 *
 * Corrections and revocations were scattered across each record's detail screen. That shows
 * "what happened to this project" but not "what happened recently".
 * Watchers need the latter.
 *
 * **This screen discloses no new facts.** `revoked`/`superseded` public versions
 * are already served by detail lookup — the only difference is ordering by "when and what"
 * instead of "which record".
 *
 * **The screen states which kinds it does not cover.** Without separating an empty list from "that kind
 * never comes here", it reads as "nothing like that happened". The scope
 * is sent by the server in the response, so the screen does not restate it — written in two places, it diverges.
 */

const KIND_LABEL: Record<PublicDisclosureEvent["eventKind"], string> = {
  revocation: "Revocation",
  source_correction: "Source correction",
  suspension: "Suspension",
  pause: "Disclosure pause",
  dispute: "Dispute",
};

const KIND_MEANING: Record<PublicDisclosureEvent["eventKind"], string> = {
  revocation: "The record was withdrawn. Its bytes remain anchored; its standing does not.",
  source_correction: "A newer version replaced this one. The earlier version stays readable.",
  suspension: "The project moved into or out of the suspended state. The reason is not published.",
  pause: "Disclosure about this project was restricted for a period. The legal basis is not published.",
  dispute: "An attestation on this project was disputed. The grounds are not published.",
};

/**
 * No distinct color per event.
 *
 * Five colors for five kinds would make **color the only distinguishing cue**, failing WCAG 1.4.1
 * (OD-31). Label and description state the kind, so color splits only into "irreversible"
 * and "other".
 */
const IRREVERSIBLE: ReadonlySet<PublicDisclosureEvent["eventKind"]> = new Set(["revocation"]);

function projectionText(projection: Record<string, unknown>, field: string): string | null {
  const value = projection[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Last column.
 *
 * Each kind holds something different — version, state transition, resolution. Three columns
 * would be mostly empty, and an empty cell cannot distinguish "no value" from "this kind has no
 * such item".
 */
function detailOf(event: PublicDisclosureEvent): string {
  if (event.registryVersion) return `v${event.registryVersion.version}`;
  if (event.lifecycle) return `${event.lifecycle.fromState} → ${event.lifecycle.toState}`;
  return event.resolvedAt ? `Resolved ${event.resolvedAt}` : "Still open";
}

export default function DisclosuresPage() {
  const [page, setPage] = useState<PublicDisclosureList | null>(null);
  const [items, setItems] = useState<PublicDisclosureEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    listPublicDisclosures({ limit: 20 })
      .then((first) => {
        if (!live) return;
        setPage(first);
        setItems(first.items);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, []);

  async function more() {
    if (!page?.nextCursor) return;
    setBusy(true);
    try {
      const next = await listPublicDisclosures({ limit: 20, cursor: page.nextCursor });
      setItems((previous) => [...previous, ...next.items]);
      setPage(next);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Disclosures &amp; Incidents</h1>
          <p className="sub">
            Corrections and revocations across the public registries, newest first. A correction does
            not erase what it corrects — the earlier version stays readable and marked.
          </p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel" data-testid="disclosure-timeline">
        {items.length === 0 && !busy ? (
          <p className="sub" style={{ margin: 0 }}>
            No published record has been corrected or revoked. This is not a permission problem, and
            it does not mean nothing has happened — see the scope note below.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What happened</th>
                  <th>Registry</th>
                  <th>Record</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((event) => (
                  <tr key={event.eventId}>
                    <td className="mono meta" style={{ whiteSpace: "nowrap" }}>
                      {event.occurredAt}
                    </td>
                    <td>
                      <span
                        style={{
                          color: IRREVERSIBLE.has(event.eventKind)
                            ? "var(--destructive-text)"
                            : "var(--alert)",
                        }}
                      >
                        {KIND_LABEL[event.eventKind]}
                      </span>
                      <div className="meta">{KIND_MEANING[event.eventKind]}</div>
                    </td>
                    <td className="mono">{event.registryType}</td>
                    <td className="mono">
                      {event.registryType === "project" ? (
                        <Link href={`/explorer/projects/${encodeURIComponent(event.publicKey)}`}>
                          {event.publicKey}
                        </Link>
                      ) : (
                        event.publicKey
                      )}
                      <div className="meta">
                        {projectionText(event.registryVersion?.projection ?? {}, "projectName") ??
                          ""}
                      </div>
                    </td>
                    <td className="mono">{detailOf(event)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {page?.nextCursor ? (
          <button style={{ marginTop: 14 }} disabled={busy} onClick={() => void more()}>
            {busy ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>

      {/*
        The response states the scope, not the screen. Restating it here means when the server adds kinds,
        only the screen keeps showing the old list.
      */}
      {page ? (
        <div className="panel" data-testid="disclosure-not-covered">
          <h2>Not covered by this timeline</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            These event kinds exist in the domain but do not reach this page. An empty timeline above
            is not a statement that none of them occurred.
          </p>
          <dl className="dl">
            {page.notCovered.map((entry) => (
              <div key={entry.kind} style={{ display: "contents" }}>
                <dt className="mono">{entry.kind}</dt>
                <dd style={{ color: "var(--muted-foreground)" }}>{entry.reason}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </>
  );
}
