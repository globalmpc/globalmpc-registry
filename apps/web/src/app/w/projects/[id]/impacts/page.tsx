"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import {
  getDocumentGraph,
  listDocumentImpacts,
  newIdempotencyKey,
  resolveDocumentImpacts,
  type DocumentImpact,
  type DocumentNode,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { DocumentTree } from "@/components/DocumentTree";
import { CAUSE_LABEL, KIND_LABEL, RESOLUTION_LABEL, documentLabel } from "@/lib/documents";

/**
 * Documents that need a second look.
 *
 * Grouped by the change that raised them — one replaced license, one expired permit — and drawn
 * as a tree, because the question people ask is "what did this change touch", not "list every
 * flagged file".
 *
 * **An open impact is a request to check, not a finding that the document is wrong.** Revising
 * is done by uploading a new version of the flagged document; the database then closes the
 * impact itself. The judgments here are for documents that hold as they are.
 */
type Judgment = "no_change_needed" | "not_applicable";

interface Group {
  readonly key: string;
  readonly originUploadId: string;
  readonly cause: DocumentImpact["cause"];
  readonly successorUploadId: string | null;
  readonly self: DocumentImpact | null;
  readonly downstream: DocumentImpact[];
}

function groupOpen(impacts: readonly DocumentImpact[]): Group[] {
  const groups = new Map<string, Group>();
  for (const impact of impacts) {
    if (impact.resolution !== "open") continue;
    const key = `${impact.originUploadId}:${impact.cause}`;
    const current: Group = groups.get(key) ?? {
      key,
      originUploadId: impact.originUploadId,
      cause: impact.cause,
      successorUploadId: impact.successorUploadId,
      self: null,
      downstream: [],
    };
    groups.set(
      key,
      impact.depth === 0
        ? { ...current, self: impact }
        : { ...current, downstream: [...current.downstream, impact] },
    );
  }
  return [...groups.values()];
}

export default function ImpactsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, loading: sessionLoading } = useSession();

  const [impacts, setImpacts] = useState<DocumentImpact[]>([]);
  const [nodes, setNodes] = useState<Map<string, DocumentNode>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [judgment, setJudgment] = useState<Judgment>("no_change_needed");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [impactData, graphData] = await Promise.all([
        listDocumentImpacts(token, id),
        getDocumentGraph(token, id),
      ]);
      setImpacts(impactData.items);
      setNodes(new Map(graphData.nodes.map((node) => [node.uploadId, node])));
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [token, id]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

  const groups = useMemo(() => groupOpen(impacts), [impacts]);
  const closed = impacts.filter((impact) => impact.resolution !== "open");

  function toggle(impactId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(impactId)) next.delete(impactId);
      else next.add(impactId);
      return next;
    });
  }

  async function applyJudgment() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      // All or nothing on the server. If one was closed meanwhile, nothing changes and the
      // envelope names it — the selection stays so the person can adjust it.
      await resolveDocumentImpacts(
        token,
        id,
        { impactIds: [...selected], resolution: judgment, note: note.trim() },
        newIdempotencyKey(),
      );
      setSelected(new Set());
      setNote("");
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (!sessionLoading && !token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  function row(impact: DocumentImpact) {
    const label = documentLabel(nodes.get(impact.uploadId), impact.uploadId);
    return (
      <span className="row" style={{ gap: 8, display: "inline-flex" }}>
        <input
          type="checkbox"
          aria-label={`Select ${label}`}
          data-testid={`impact-select-${impact.id}`}
          checked={selected.has(impact.id)}
          onChange={() => toggle(impact.id)}
        />
        <Link href={`/w/projects/${id}/documents/${impact.uploadId}`}>{label}</Link>
        {impact.viaKind ? (
          <span className="meta">— {KIND_LABEL[impact.viaKind]} the document above</span>
        ) : null}
        <Link className="meta" href={`/w/projects/${id}/documents/${impact.uploadId}`}>
          Upload a revised version
        </Link>
      </span>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Documents that need a second look</h1>
          <p className="sub">
            A document they rest on was replaced or passed its validity date. That does not make
            them wrong — someone who knows them has to check.
          </p>
        </div>
        <Link href={`/w/projects/${id}/data-room`}>← Data Room</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel">
        <h2>Judge the selected documents</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          For documents that hold as they are. To revise one, upload a new version from its page;
          the impact closes itself when that version is promoted. A judgment is recorded with your
          reason and is not reopened.
        </p>
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            void applyJudgment();
          }}
        >
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="impact-judgment">Judgment</label>
            <select
              id="impact-judgment"
              value={judgment}
              onChange={(event) => setJudgment(event.target.value as Judgment)}
            >
              <option value="no_change_needed">No change needed — it still holds</option>
              <option value="not_applicable">Not applicable — the link does not fit this change</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 240 }}>
            <label htmlFor="impact-note">Reason</label>
            <input
              id="impact-note"
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={busy || selected.size === 0 || note.trim() === ""}
          >
            Apply to {selected.size} selected
          </button>
        </form>
        {judgment === "not_applicable" ? (
          <p className="meta" style={{ marginTop: 10 }}>
            If the link does not fit, fix or remove it on the document page so the next change
            does not flag this document again.
          </p>
        ) : null}
      </div>

      {loading ? (
        <p className="sub">Loading…</p>
      ) : groups.length === 0 ? (
        <div className="panel">
          <p className="sub" style={{ margin: 0 }} data-testid="impacts-empty">
            No document is waiting for a second look.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <div className="panel" key={group.key} data-testid={`impact-group-${group.originUploadId}`}>
            <h2>
              <Link href={`/w/projects/${id}/documents/${group.originUploadId}`}>
                {documentLabel(nodes.get(group.originUploadId), group.originUploadId)}
              </Link>{" "}
              was {CAUSE_LABEL[group.cause]}
            </h2>
            {group.successorUploadId ? (
              <p className="meta" style={{ marginTop: 0 }}>
                New version:{" "}
                <Link href={`/w/projects/${id}/documents/${group.successorUploadId}`}>
                  {documentLabel(nodes.get(group.successorUploadId), group.successorUploadId)}
                </Link>
              </p>
            ) : null}
            {group.self ? (
              <div style={{ margin: "6px 0" }}>
                {row(group.self)}
                <span className="meta"> — the document itself needs renewing or a check</span>
              </div>
            ) : null}
            <DocumentTree
              rootId={group.originUploadId}
              items={group.downstream}
              renderItem={row}
            />
          </div>
        ))
      )}

      <div className="panel">
        <h2>Already judged</h2>
        {closed.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing judged yet.
          </p>
        ) : (
          <div className="table-scroll">
            <table data-testid="impacts-closed">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Because</th>
                  <th>Judgment</th>
                  <th>Reason</th>
                  <th>Closed by</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((impact) => (
                  <tr key={impact.id}>
                    <td>
                      <Link href={`/w/projects/${id}/documents/${impact.uploadId}`}>
                        {documentLabel(nodes.get(impact.uploadId), impact.uploadId)}
                      </Link>
                    </td>
                    <td className="meta">
                      {documentLabel(nodes.get(impact.originUploadId), impact.originUploadId)} was{" "}
                      {CAUSE_LABEL[impact.cause]}
                    </td>
                    <td>{RESOLUTION_LABEL[impact.resolution]}</td>
                    <td className="meta">{impact.resolutionNote ?? "—"}</td>
                    <td className="meta">
                      {/* Say who closed it. A database-closed impact and a person's judgment
                          read differently when the next change comes. */}
                      {impact.resolvedBy === null ? (
                        "The database, when a new version took effect"
                      ) : (
                        <span className="mono">{impact.resolvedBy.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="mono meta">{impact.resolvedAt?.slice(0, 10) ?? "—"}</td>
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
