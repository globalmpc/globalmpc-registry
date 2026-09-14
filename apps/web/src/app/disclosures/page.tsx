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
 * 정정과 철회는 각 기록의 상세 화면에 흩어져 있었다. 그러면 "이 프로젝트에
 * 무슨 일이 있었나"는 볼 수 있어도 "최근에 무슨 일이 있었나"는 볼 수 없다.
 * 감시자에게 필요한 것은 후자다.
 *
 * **이 화면은 새 사실을 공개하지 않는다.** `revoked`·`superseded` 공개 version은
 * 이미 상세 조회로 나간다 — 다른 것은 "어느 기록에서" 대신 "언제 무슨 일이"로
 * 정렬한다는 점뿐이다.
 *
 * **덮지 않는 종류를 화면이 말한다.** 목록이 비어 있는 것과 "그 종류는 애초에
 * 여기 오지 않는다"를 구분하지 않으면 "그런 일이 없었다"로 읽힌다. 범위는
 * 서버가 응답에 담아 보내므로 화면이 따로 적지 않는다 — 두 곳에 적으면 갈라진다.
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
 * 사건마다 색을 다르게 두지 않는다.
 *
 * 다섯 종류에 다섯 색을 주면 **색이 유일한 구분 수단**이 되고 WCAG 1.4.1에
 * 걸린다(OD-31). 라벨과 설명이 종류를 말하므로 색은 "되돌릴 수 없는 것"과
 * "그 외" 둘로만 나눈다.
 */
const IRREVERSIBLE: ReadonlySet<PublicDisclosureEvent["eventKind"]> = new Set(["revocation"]);

function projectionText(projection: Record<string, unknown>, field: string): string | null {
  const value = projection[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 마지막 칸.
 *
 * 종류마다 담을 것이 다르다 — version, 상태 전이, 해소 여부. 칸을 셋으로
 * 늘리면 대부분이 비고, 비어 있는 칸은 "값이 없다"와 "이 종류에는 그 항목이
 * 없다"를 구분하지 못한다.
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
        범위를 화면이 아니라 응답이 말한다. 여기에 다시 적으면 서버가 종류를
        늘렸을 때 화면만 옛 목록을 계속 보인다.
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
