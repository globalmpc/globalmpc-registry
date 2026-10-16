"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import {
  declareDocumentRequirement,
  getDocumentStatusSummary,
  listProjectDocuments,
  newIdempotencyKey,
  retireDocumentRequirement,
  type DocumentListFilter,
  type DocumentListItem,
  type DocumentRequirementTier,
  type DocumentStatus,
  type DocumentStatusSummary,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { validityText } from "@/lib/documents";
import {
  DOCUMENT_STATUS_LABEL,
  REQUIREMENT_STATUS_GLYPH,
  REQUIREMENT_STATUS_LABEL,
  STATUSES,
  TIERS,
  TIER_EXPLANATION,
  TIER_LABEL,
  withExpiryWindow,
  withStatusFilter,
} from "@/lib/document-status";

/**
 * Document status — what the project expects, and where its documents stand.
 *
 * One screen answers the questions people preparing thousands of documents ask: is anything
 * required missing or expired, what was replaced, what is still waiting for a scan, and which
 * types nobody has classified yet. Counts come from the server; the list pages, so a large
 * project is shown whole rather than cut at a fixed size.
 *
 * **Nothing is required until someone here says so.** There is no agreed catalog of document
 * types, so the project's own Data Room team declares the types it expects and their tier.
 */
const PAGE_SIZE = 50;

export default function DocumentStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, loading: sessionLoading } = useSession();

  const [summary, setSummary] = useState<DocumentStatusSummary | null>(null);
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<DocumentListFilter>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [newType, setNewType] = useState("");
  const [newTier, setNewTier] = useState<DocumentRequirementTier>("required");
  const [newNote, setNewNote] = useState("");
  const [retireReason, setRetireReason] = useState<Record<string, string>>({});

  const loadSummary = useCallback(async () => {
    if (!token) return;
    try {
      setSummary(await getDocumentStatusSummary(token, id));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [token, id]);

  // Each request takes a number; only the latest one may write the list. Typing a type filter
  // sends one request per keystroke, and an earlier answer arriving late would otherwise show
  // documents — and a "Show more" cursor — for a filter no longer on screen.
  const latestRequest = useRef(0);

  const loadList = useCallback(
    async (cursor?: string) => {
      if (!token) return;
      const request = ++latestRequest.current;
      try {
        const page = await listProjectDocuments(token, id, { ...filter, limit: PAGE_SIZE, cursor });
        if (request !== latestRequest.current) return;
        setItems((current) => (cursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (caught) {
        if (request === latestRequest.current) setError(caught);
      }
    },
    [token, id, filter],
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function declare(event: React.FormEvent) {
    event.preventDefault();
    if (!token || !newType.trim()) return;
    setBusy(true);
    try {
      await declareDocumentRequirement(
        token,
        id,
        { documentType: newType.trim(), tier: newTier, note: newNote.trim() || null },
        newIdempotencyKey(),
      );
      setNewType("");
      setNewNote("");
      await loadSummary();
      await loadList();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function retire(requirementId: string) {
    const reason = retireReason[requirementId]?.trim();
    if (!token || !reason) return;
    setBusy(true);
    try {
      await retireDocumentRequirement(token, requirementId, reason, newIdempotencyKey());
      setRetireReason((current) => ({ ...current, [requirementId]: "" }));
      await loadSummary();
      await loadList();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (sessionLoading) return <p className="meta">Loading…</p>;
  if (!token) {
    return (
      <p className="meta">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  const totals = summary?.totals;
  const tiles: { label: string; value: number | undefined; status?: DocumentStatus }[] = [
    { label: "All documents", value: totals?.all },
    { label: "Current", value: totals?.current, status: "current" },
    { label: "Expired", value: totals?.expired, status: "expired" },
    { label: "Replaced", value: totals?.superseded, status: "superseded" },
    { label: "Not promoted yet", value: totals?.pending, status: "pending" },
    { label: "Failed scanning or rejected", value: totals?.unusable, status: "unusable" },
  ];

  const renderDocumentsByStatus = () => {
    return (
      <div className="panel">
        <h2>Documents by status</h2>
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          {tiles.map((tile) => (
            <button
              key={tile.label}
              type="button"
              className="field"
              aria-pressed={filter.status === tile.status && filter.tier === undefined}
              onClick={() => setFilter(tile.status ? { status: tile.status } : {})}
            >
              <div className="meta">{tile.label}</div>
              <div style={{ fontSize: 24 }}>{tile.value ?? "—"}</div>
            </button>
          ))}
        </div>
        {totals ? (
          <p className="meta" style={{ marginTop: 10 }}>
            {totals.untyped} current or expired document{totals.untyped === 1 ? " has" : "s have"} no
            type and cannot count toward any requirement. {totals.withoutValidUntil} current document
            {totals.withoutValidUntil === 1 ? " has" : "s have"} no last valid day.{" "}
            <Link href={`/w/projects/${id}/impacts`}>
              {totals.openImpacts} open impact{totals.openImpacts === 1 ? "" : "s"} →
            </Link>
          </p>
        ) : null}
      </div>
    );
  };

  const renderCoverageByTier = () => {
    return (
      <div className="panel">
        <h2>Coverage by tier</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tier</th>
                <th>Declared types</th>
                <th>Met</th>
                <th>Only expired</th>
                <th>Not promoted yet</th>
                <th>Missing</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.tiers ?? []).map((tier) => (
                <tr key={tier.tier}>
                  <td>
                    <button
                      type="button"
                      className="field"
                      onClick={() => setFilter({ tier: tier.tier })}
                      title={TIER_EXPLANATION[tier.tier]}
                    >
                      {TIER_LABEL[tier.tier]}
                    </button>
                    {tier.incomplete ? <div className="meta">! Incomplete</div> : null}
                  </td>
                  <td>{tier.declared}</td>
                  <td>{tier.met}</td>
                  <td>{tier.expired}</td>
                  <td>{tier.pending}</td>
                  <td>{tier.missing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {summary && summary.tiers.every((tier) => tier.declared === 0) ? (
          <p className="meta">
            No document types are declared yet, so nothing counts as required. Declare the types this
            project expects below.
          </p>
        ) : null}
      </div>
    );
  };

  const renderExpectedDocumentTypes = () => {
    return (
      <div className="panel">
        <h2>Expected document types</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Current</th>
                <th>Expired</th>
                <th>Not promoted</th>
                <th>Replaced</th>
                <th>Nearest expiry</th>
                <th>Retire</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.requirements ?? []).map((progress) => (
                <tr key={progress.requirement.id}>
                  <td>
                    <button
                      type="button"
                      className="field"
                      onClick={() => setFilter({ documentType: progress.requirement.documentType })}
                    >
                      {progress.requirement.documentType}
                    </button>
                    {progress.requirement.note ? (
                      <div className="meta">{progress.requirement.note}</div>
                    ) : null}
                  </td>
                  <td>{TIER_LABEL[progress.requirement.tier]}</td>
                  <td>
                    <span className="badge">
                      <span className="glyph" aria-hidden="true">
                        {REQUIREMENT_STATUS_GLYPH[progress.status]}
                      </span>
                      {REQUIREMENT_STATUS_LABEL[progress.status]}
                    </span>
                  </td>
                  <td>{progress.currentCount}</td>
                  <td>{progress.expiredCount}</td>
                  <td>{progress.pendingCount}</td>
                  <td>{progress.supersededCount}</td>
                  <td className="meta">
                    {validityText(progress.nearestValidUntil, progress.daysUntilExpiry)}
                  </td>
                  <td>
                    <input
                      aria-label={`Reason to retire ${progress.requirement.documentType}`}
                      placeholder="Reason"
                      value={retireReason[progress.requirement.id] ?? ""}
                      onChange={(event) =>
                        setRetireReason((current) => ({
                          ...current,
                          [progress.requirement.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      disabled={busy || !retireReason[progress.requirement.id]?.trim()}
                      onClick={() => void retire(progress.requirement.id)}
                    >
                      Retire
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form onSubmit={declare} className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <input
            aria-label="Document type"
            placeholder="Document type, e.g. Exploration licence"
            maxLength={80}
            value={newType}
            onChange={(event) => setNewType(event.target.value)}
          />
          <select
            aria-label="Tier"
            value={newTier}
            onChange={(event) => setNewTier(event.target.value as DocumentRequirementTier)}
          >
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {TIER_LABEL[tier]}
              </option>
            ))}
          </select>
          <input
            aria-label="Note"
            placeholder="Note (optional)"
            maxLength={500}
            value={newNote}
            onChange={(event) => setNewNote(event.target.value)}
          />
          <button type="submit" disabled={busy || !newType.trim()}>
            Declare type
          </button>
        </form>
        <p className="meta">{TIER_EXPLANATION[newTier]} Types match uploads regardless of case.</p>
      </div>
    );
  };

  const renderTypesNobodyDeclared = () => {
    return summary && summary.undeclaredTypes.length > 0 ? (
      <div className="panel">
        <h2>Types nobody declared</h2>
        <p className="meta">
          These types appear on uploads but are in no tier. Declare them above to track them.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Current</th>
                <th>Expired</th>
                <th>Not promoted</th>
                <th>Replaced</th>
              </tr>
            </thead>
            <tbody>
              {summary.undeclaredTypes.map((type) => (
                <tr key={type.documentType}>
                  <td>
                    <button
                      type="button"
                      className="field"
                      onClick={() => setNewType(type.documentType)}
                    >
                      {type.documentType}
                    </button>
                  </td>
                  <td>{type.currentCount}</td>
                  <td>{type.expiredCount}</td>
                  <td>{type.pendingCount}</td>
                  <td>{type.supersededCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {summary.undeclaredTypesTruncated ? (
          <p className="meta">
            More undeclared types exist than shown here. Filter the list below by “Not in any tier” to
            see all of them.
          </p>
        ) : null}
      </div>
    ) : null;
  };

  const renderNextToExpire = () => {
    return summary && summary.nextExpiries.length > 0 ? (
      <div className="panel">
        <h2>Next to expire</h2>
        <ul>
          {summary.nextExpiries.map((entry) => (
            <li key={entry.uploadId}>
              <Link href={`/w/projects/${id}/documents/${entry.uploadId}`}>
                {entry.documentType ?? `Document ${entry.uploadId.slice(0, 8)}`}
              </Link>{" "}
              <span className="meta">{validityText(entry.validUntil, entry.daysUntilExpiry)}</span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  };

  const renderDocuments = () => {
    return (
      <div className="panel">
        <h2>Documents</h2>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <select
            aria-label="Status"
            value={filter.status ?? ""}
            onChange={(event) =>
              setFilter((current) =>
                withStatusFilter(
                  current,
                  (event.target.value || undefined) as DocumentStatus | undefined,
                ),
              )
            }
          >
            <option value="">Any status</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {DOCUMENT_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
          <select
            aria-label="Tier filter"
            value={filter.tier ?? ""}
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                tier: (event.target.value || undefined) as DocumentListFilter["tier"],
              }))
            }
          >
            <option value="">Any tier</option>
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {TIER_LABEL[tier]}
              </option>
            ))}
            <option value="undeclared">Not in any tier</option>
          </select>
          <input
            aria-label="Type filter"
            placeholder="Type"
            value={filter.documentType ?? ""}
            onChange={(event) =>
              setFilter((current) => ({ ...current, documentType: event.target.value || undefined }))
            }
          />
          {/* No default window: when to start worrying is an operational choice nobody has made. */}
          <input
            aria-label="Expires within days"
            placeholder="Expires within … days"
            type="number"
            min={0}
            max={3650}
            value={filter.expiresWithinDays ?? ""}
            onChange={(event) =>
              setFilter((current) =>
                withExpiryWindow(
                  current,
                  event.target.value === "" ? undefined : Number(event.target.value),
                ),
              )
            }
          />
          <button type="button" onClick={() => setFilter({})}>
            Clear filters
          </button>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Valid until</th>
                <th>Open impacts</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.uploadId}>
                  <td>
                    <Link href={`/w/projects/${id}/documents/${item.uploadId}`}>
                      {item.originalFilename ?? `Document ${item.uploadId.slice(0, 8)}`}
                    </Link>
                  </td>
                  <td>{item.documentType ?? <span className="meta">No type</span>}</td>
                  <td>{item.tier ? TIER_LABEL[item.tier] : <span className="meta">—</span>}</td>
                  <td>{DOCUMENT_STATUS_LABEL[item.status]}</td>
                  <td className="meta">{validityText(item.validUntil, item.daysUntilExpiry)}</td>
                  <td>{item.openImpactCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 ? <p className="meta">No documents match these filters.</p> : null}
        {nextCursor ? (
          <button type="button" onClick={() => void loadList(nextCursor)}>
            Show more
          </button>
        ) : items.length > 0 ? (
          <p className="meta">End of list · {items.length} shown.</p>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <Link href={`/w/projects/${id}`}>← Project</Link>
        <h1>Document status</h1>
        <p className="sub">
          Which documents this project expects, and where its documents stand
          {summary ? ` as of ${summary.today}` : ""}. Expiry is judged by calendar day; a
          document is valid through its last valid day.
        </p>
      </div>

      <ErrorNotice error={error} />

      {renderDocumentsByStatus()}

      {renderCoverageByTier()}

      {renderExpectedDocumentTypes()}

      {renderTypesNobodyDeclared()}

      {renderNextToExpire()}

      {renderDocuments()}
    </>
  );
}
