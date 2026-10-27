"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import {
  listClaims,
  listSourceReceipts,
  newIdempotencyKey,
  collectFromSource,
  createSourceReceipt,
  createClaim,
  createClaimConflict,
  createDownloadLink,
  createUpload,
  listUploads,
  promoteUpload,
  getDocumentGraph,
  getJurisdictionProfile,
  getProject,
  type AuthorityEntry,
  type Claim,
  type DocumentNode,
  type ObjectUpload,
  type ScannerStatus,
  type SourceReceipt,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { CatalogClaimForm } from "@/components/CatalogClaimForm";
import { WorkspaceEvidenceLedger } from "@/components/EvidenceLedger";
import { ErrorNotice } from "@/components/ErrorNotice";
import { TruncatedNotice } from "@/components/TruncatedNotice";
import { GradeBadge, SourceResultBadge } from "@/components/StatusBadge";
import { validityText } from "@/lib/documents";
import { PHOTO_ACCEPT, UPLOAD_ACCEPT } from "@/lib/uploads";
import { keccak256 } from "@mpc/canonical";
import { SOURCE_RESULTS, type Grade, type SourceResult } from "@mpc/domain";

/**
 * Data Room — spec 11 §11.3.
 *
 * A **claim/evidence-centered view**, not folders. It shows "what was confirmed
 * from which source", not a file list.
 *
 * The core is that each of the 12 source results has its own badge and next action —
 * if "no record" and "cannot confirm" look alike, users keep retrying a record
 * that does not exist (AC-18).
 */
export default function DataRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, session, loading: sessionLoading } = useSession();
  const canCreateClaim = session?.actions?.includes("claim.curate") ?? false;
  const [ledgerRevision, setLedgerRevision] = useState(0);

  const [receipts, setReceipts] = useState<SourceReceipt[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [uploads, setUploads] = useState<ObjectUpload[]>([]);
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);
  // Open impacts and server-side day counts per document. The upload list itself does not
  // carry them — they depend on links, not on the file.
  const [nodes, setNodes] = useState<Record<string, DocumentNode>>({});
  // Connections of the project's jurisdiction. Receipts are recorded against one the user
  // picks — never a fixed demo id (REQ-DAPP-049).
  const [sources, setSources] = useState<AuthorityEntry[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [queryField, setQueryField] = useState("");
  const [queryValue, setQueryValue] = useState("");
  const [manualResult, setManualResult] = useState<SourceResult>("source_returned_no_record");
  const [documentRef, setDocumentRef] = useState("");
  const [documentUploadId, setDocumentUploadId] = useState("");
  const [originalText, setOriginalText] = useState("");
  const [limitation, setLimitation] = useState("");
  // Capped lists say so. Files page by cursor; the panels carry a flag and a count.
  const [uploadCursor, setUploadCursor] = useState<string | null>(null);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [receiptTotal, setReceiptTotal] = useState<number | null>(null);
  const [claimTotal, setClaimTotal] = useState<number | null>(null);
  const [graphLimit, setGraphLimit] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [receiptData, claimData, uploadData, graphData, project] = await Promise.all([
        listSourceReceipts(token, id),
        listClaims(token, id),
        listUploads(token, id),
        getDocumentGraph(token, id),
        getProject(token, id),
      ]);
      // The project's own jurisdiction — a receipt names a source the project can be looked up in.
      const profile = await getJurisdictionProfile(token, project.hostCountryIso3);
      const withConnection = profile.authorities.filter((entry) => entry.connectionId !== null);
      setSources(withConnection);
      setConnectionId((current) =>
        current !== "" && withConnection.some((entry) => entry.connectionId === current)
          ? current
          : (withConnection[0]?.connectionId ?? ""),
      );
      setReceipts(receiptData.items);
      setReceiptTotal(receiptData.truncated ? receiptData.total : null);
      setClaims(claimData.items);
      setClaimTotal(claimData.truncated ? claimData.total : null);
      setUploads(uploadData.items);
      setUploadCursor(uploadData.nextCursor);
      setUploadTotal(uploadData.total);
      setScanner(uploadData.scanner);
      setNodes(Object.fromEntries(graphData.nodes.map((node) => [node.uploadId, node])));
      setGraphLimit(graphData.truncated ? graphData.limit : null);
      setError(null);
      setLedgerRevision((current) => current + 1);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [token, id]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

  const selectedSource = sources.find((entry) => entry.connectionId === connectionId) ?? null;
  const query =
    queryField.trim() !== "" && queryValue.trim() !== ""
      ? { [queryField.trim()]: queryValue.trim() }
      : null;
  // Only a scanned file can stand behind a receipt; the server refuses the rest.
  const evidenceUploads = uploads.filter(
    (upload) => upload.state === "scanned_clean" || upload.state === "promoted",
  );

  /** The next page of files, appended. The cursor comes from the server and goes back as is. */
  async function loadMoreUploads() {
    if (!token || !uploadCursor) return;
    setBusy(true);
    setError(null);
    try {
      const page = await listUploads(token, id, uploadCursor);
      setUploads((current) => [...current, ...page.items]);
      setUploadCursor(page.nextCursor);
      setUploadTotal(page.total);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  /**
   * **Actually calls** the official source.
   *
   * This screen used to send `confirmed_from_source` directly. That turned the meaning of
   * confirmation from "we checked" into **"the uploader said so"**. Confirmation
   * comes only from the answer the server gets by calling the source — if it cannot answer, that fact is recorded.
   */
  async function lookUpSource() {
    if (!selectedSource || !query) return;
    await step((activeToken) =>
      collectFromSource(activeToken, connectionId, id, query, newIdempotencyKey()),
    );
  }

  /**
   * Records what a person saw at the source — REQ-DAPP-032, REQ-DAPP-049.
   *
   * Everything here is what the person entered or chose: the connection (and so its authority),
   * the query, the reference, and the original. The raw hash is the scanned document's (the
   * server takes it) or a hash of the text as received; with neither, no original is recorded
   * rather than a placeholder. Freshness is the server's to compute.
   */
  async function recordManualResult() {
    if (!selectedSource || !query || documentRef.trim() === "") return;
    const text = originalText.trim();
    await step((activeToken) =>
      createSourceReceipt(
        activeToken,
        id,
        {
          connectionId,
          authorityId: selectedSource.id,
          result: manualResult,
          collectionMethod: "manual_official_registry_confirmation",
          queryBasis: query,
          endpointOrDocumentRef: documentRef.trim(),
          authenticationMethod: "manual_verification",
          rawHash:
            documentUploadId === "" && text !== ""
              ? keccak256(new TextEncoder().encode(text))
              : null,
          documentUploadId: documentUploadId === "" ? null : documentUploadId,
          asOf: new Date().toISOString(),
          limitations: limitation.trim() === "" ? [] : [limitation.trim()],
        },
        newIdempotencyKey(),
      ),
    );
  }

  async function addClaim() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await createClaim(
        token,
        id,
        {
          claimType: "mining_right_registration",
          valueText: `MV-${Math.floor(Math.random() * 900000 + 100000)}`,
          sourceCoordinate: { document: "license-extract", page: "1" },
          evidenceTier: "P1",
          // No verification state: a claim starts unreviewed and moves only when a review is
          // signed (REQ-DAPP-004).
        },
        newIdempotencyKey(),
      );
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Record a conflict.
   *
   * Sends this claim's current version too. If someone else changed it while the list
   * was open, the server rejects with 412 and the screen shows that as is.
   */
  async function addConflict(claim: Claim) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await createClaimConflict(
        token,
        claim.id,
        claim.version,
        "estimate_conflict",
        newIdempotencyKey(),
      );
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  /** Upload a file. The upload goes into quarantine, not evidence. */
  async function addUpload(file: File) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await createUpload(token, id, file, newIdempotencyKey());
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Wrap token-requiring actions in one place.
   *
   * Why the token is passed as an argument: `token` at render time can be null while the session loads.
   * Checking at every call site means one will miss it.
   */
  async function step(action: (activeToken: string) => Promise<unknown>) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await action(token);
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

  const renderNotice = () => {
    return scanner && scanner.state !== "running" ? (
      <div
        className="notice"
        style={{
          color: scanner.state === "unknown" ? "var(--alert)" : "var(--destructive-text)",
        }}
        data-testid="scanner-status"
        role="alert"
      >
        <div className="title">
          {scanner.state === "never_seen"
            ? "No scan worker has ever reported"
            : scanner.state === "stale"
              ? "The scan worker has gone quiet"
              : scanner.state === "unavailable"
                ? "The malware scanner is unavailable"
                : "Malware scanner state is unknown"}
        </div>
        {scanner.state === "unknown"
          ? "We cannot confirm scanner availability. Treat quarantined uploads as unverified until this resolves."
          : scanner.state === "unavailable"
            ? "The scan worker is running, but the malware scanner cannot accept files. Scanning is paused; uploads remain in quarantine and cannot be promoted to evidence until the scanner recovers."
            : "Uploads will stay in quarantine and cannot be promoted to evidence until a scanner runs. This is not a queue you can wait out."}
        {scanner.secondsSinceHeartbeat !== null ? (
          <div className="meta" style={{ marginTop: 6, color: "inherit" }}>
            Worker last seen {scanner.secondsSinceHeartbeat}s ago.
          </div>
        ) : null}
      </div>
    ) : null;
  };

  const renderFiles = () => {
    const renderChooseAFile = () => {
      return (
        <div className="upload-inputs">
          <div className="field">
            <label htmlFor="upload">Choose a file</label>
            <input
              id="upload"
              type="file"
              accept={UPLOAD_ACCEPT}
              data-testid="upload-input"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void addUpload(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="upload-photo">Take a photo</label>
            <input
              id="upload-photo"
              type="file"
              accept={PHOTO_ACCEPT}
              capture="environment"
              data-testid="upload-photo-input"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void addUpload(file);
                event.target.value = "";
              }}
            />
          </div>
        </div>
      );
    };

    const renderUploadRow = (upload: (typeof uploads)[number]) => {
      const renderUploadActions = () => {
        return (
          <td>
            <div className="row" style={{ gap: 6 }}>
              <Link
                href={`/w/projects/${id}/documents/${upload.id}`}
                data-testid={`relations-${upload.id}`}
              >
                Relations
              </Link>
              {upload.state === "received" || upload.state === "quarantined" ? (
                // A separate worker performs the scan. If the screen could
                // produce a result, quarantine would be a formality.
                <span className="meta">Awaiting scan</span>
              ) : null}

              {upload.state === "scanned_clean" ? (
                <button
                  className="primary"
                  data-testid={`promote-${upload.id}`}
                  disabled={busy}
                  onClick={() =>
                    void step((activeToken) =>
                      promoteUpload(activeToken, upload.id, upload.version, newIdempotencyKey()),
                    )
                  }
                >
                  Promote to evidence
                </button>
              ) : null}

              {/* Only scanned files get a link. The server refuses the rest. */}
              {upload.state === "scanned_clean" || upload.state === "promoted" ? (
                <button
                  data-testid={`download-${upload.id}`}
                  disabled={busy}
                  onClick={() =>
                    void step(async (activeToken) => {
                      const link = await createDownloadLink(
                        activeToken,
                        upload.id,
                        newIdempotencyKey(),
                      );
                      window.open(link.url, "_blank", "noopener");
                    })
                  }
                >
                  Download
                </button>
              ) : null}
            </div>
          </td>
        );
      };

      return (
        <tr key={upload.id}>
          <td className="meta">{upload.originalFilename ?? "—"}</td>
          <td className="meta">{upload.documentType ?? "—"}</td>
          <td
            className="mono meta"
            data-testid={`upload-validity-${upload.id}`}
            style={nodes[upload.id]?.expired ? { color: "var(--destructive-text)" } : undefined}
          >
            {validityText(upload.validUntil, nodes[upload.id]?.daysUntilExpiry)}
          </td>
          <td>
            <span
              className="mono"
              data-testid={`upload-state-${upload.id}`}
              style={{ color: uploadColor(upload.state) }}
            >
              {upload.state}
            </span>
          </td>
          <td className="mono meta">{Math.ceil(upload.byteSize / 1024)} KB</td>
          <td className="mono" data-testid={`upload-impacts-${upload.id}`}>
            {/* Not 0 when the graph did not carry this document: unknown is not none. */}
            {nodes[upload.id]?.openImpactCount ?? "—"}
          </td>
          <td className="meta">{upload.nextActions.join(", ") || "—"}</td>
          {renderUploadActions()}
        </tr>
      );
    };

    const renderUploadTable = () => {
      return uploads.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>
          No files uploaded. There is no data here; this is not a permission problem.
        </p>
      ) : (
        <div className="table-scroll">
          <table data-testid="upload-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Valid until</th>
                <th>State</th>
                <th>Size</th>
                <th>Open impacts</th>
                <th>Next action</th>
                <th />
              </tr>
            </thead>
            <tbody>{uploads.map(renderUploadRow)}</tbody>
          </table>
        </div>
      );
    };

    const renderUploadsLoadMore = () => {
      return uploadCursor ? (
        <TruncatedNotice
          shown={uploads.length}
          total={uploadTotal}
          noun="files"
          testId="uploads-truncated"
        >
          <button
            data-testid="uploads-load-more"
            disabled={busy}
            onClick={() => void loadMoreUploads()}
          >
            {busy ? "Loading…" : "Load more files"}
          </button>
        </TruncatedNotice>
      ) : null;
    };

    return (
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2>Files</h2>
          <Link href={`/w/projects/${id}/impacts`} data-testid="impacts-link">
            Documents that need a second look →
          </Link>
        </div>
        <p className="sub" style={{ marginTop: 0 }}>
          {/* If uploads became evidence immediately, unscanned files would become review material. */}
          An uploaded file does not become evidence on arrival. It enters quarantine, and only after
          the scan worker finishes can it be promoted to evidence.
        </p>

        {/* Two inputs, not one: the camera is offered only where a photo is meant. Forcing it on
                the general picker would stop people on a phone from attaching a saved file. */}
        {renderChooseAFile()}

        {renderUploadTable()}

        {renderUploadsLoadMore()}
        {graphLimit !== null ? (
          <p className="meta" data-testid="uploads-graph-truncated">
            Open impacts are counted for the newest {graphLimit.toLocaleString("en-US")} documents.
            Older files show — here; their own page has the count.
          </p>
        ) : null}

        <p className="meta" style={{ marginTop: 10 }}>
          {/* No path reverses an infected verdict — enforced by the state machine, not permissions. */}
          A separate worker runs the scan; this screen cannot produce the result. A file judged
          infected cannot be rescanned and is never promoted to evidence — upload it again as a new
          file. Only a file that passed the scan can be downloaded. Download links expire after five
          minutes, and anyone holding one can fetch the file without signing in.
        </p>
      </div>
    );
  };

  const renderSourceReceipt = () => {
    return (
      <div className="panel">
        <h2>Source Receipt</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          The twelve results are different facts. Each carries a different next action.
        </p>
        {/*
              State in readable text that confirmation cannot be entered from the screen.
              Just removing the button leaves "why is it missing" unanswered, and people look for a workaround.
            */}
        <p className="sub" style={{ marginTop: 0 }}>
          A confirmation is not something this screen can record. It comes from the server calling the
          official source, or from a signed document the server verified against a registered key. The
          buttons below record what actually happened.
        </p>

        {sources.length === 0 ? (
          <p className="sub" data-testid="no-source-connection">
            This project’s jurisdiction has no registered source connection, so there is nothing to
            look up or record against. Register a connection first.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="source-connection">Source connection</label>
              <select
                id="source-connection"
                value={connectionId}
                disabled={busy}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                {sources.map((entry) => (
                  <option key={entry.connectionId} value={entry.connectionId ?? ""}>
                    {entry.name} · {entry.connectionKey} ({entry.adapterState})
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="query-field">Query field</label>
                <input
                  id="query-field"
                  value={queryField}
                  onChange={(event) => setQueryField(event.target.value)}
                  placeholder="The identifier the source is searched by"
                />
              </div>
              <div className="field">
                <label htmlFor="query-value">Query value</label>
                <input
                  id="query-value"
                  value={queryValue}
                  onChange={(event) => setQueryValue(event.target.value)}
                />
              </div>
            </div>

            <div className="row" style={{ marginBottom: 14 }}>
              <button
                onClick={() => void lookUpSource()}
                disabled={busy || !selectedSource || !query}
              >
                Look up the official source
              </button>
              {selectedSource && !selectedSource.callable && selectedSource.nextAction ? (
                <span className="meta">{selectedSource.nextAction}</span>
              ) : null}
            </div>

            <h3>Record a manual check</h3>
            <p className="meta" style={{ marginTop: 0 }}>
              For what you saw at the source yourself. A confirmation cannot be recorded here; it
              needs the server lookup, a verified signed document, or a second person’s review.
            </p>
            <div className="field">
              <label htmlFor="manual-result">Result</label>
              <select
                id="manual-result"
                value={manualResult}
                onChange={(event) => setManualResult(event.target.value as SourceResult)}
              >
                {SOURCE_RESULTS.filter((result) => result !== "confirmed_from_source").map(
                  (result) => (
                    <option key={result} value={result}>
                      {result}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div className="field">
              <label htmlFor="document-ref">Document or page reference</label>
              <input
                id="document-ref"
                value={documentRef}
                onChange={(event) => setDocumentRef(event.target.value)}
                placeholder="Where the result was seen"
              />
            </div>
            <div className="field">
              <label htmlFor="document-upload">Supporting document</label>
              <select
                id="document-upload"
                value={documentUploadId}
                onChange={(event) => setDocumentUploadId(event.target.value)}
              >
                <option value="">None</option>
                {evidenceUploads.map((upload) => (
                  <option key={upload.id} value={upload.id}>
                    {upload.originalFilename ?? upload.id}
                  </option>
                ))}
              </select>
            </div>
            {documentUploadId === "" ? (
              <div className="field">
                <label htmlFor="original-text">Original as received (optional)</label>
                <textarea
                  id="original-text"
                  rows={3}
                  value={originalText}
                  onChange={(event) => setOriginalText(event.target.value)}
                  placeholder="Paste the source's answer to keep its hash"
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="limitation">What this record does not show (optional)</label>
              <input
                id="limitation"
                value={limitation}
                onChange={(event) => setLimitation(event.target.value)}
              />
            </div>
            <div className="row" style={{ marginBottom: 14 }}>
              <button
                onClick={() => void recordManualResult()}
                disabled={busy || !selectedSource || !query || documentRef.trim() === ""}
              >
                Record the result
              </button>
              <span className="meta">
                Without a document or pasted original, the receipt says no original was kept.
              </span>
            </div>
          </>
        )}

        {loading ? (
          <p className="sub">Loading…</p>
        ) : receipts.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No source receipts recorded. There is no data here; this is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Next action</th>
                  <th>Retry</th>
                  <th>Collection method</th>
                  <th>As of</th>
                  <th>Freshness</th>
                  <th>Original</th>
                  <th>Limitations</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td>
                      <SourceResultBadge result={receipt.result as SourceResult} />
                    </td>
                    <td className="mono meta">{receipt.nextAction}</td>
                    <td>
                      {/* Keep the user from guessing whether to retry. */}
                      {receipt.retryable ? "Possible" : <span className="meta">Not useful</span>}
                    </td>
                    <td className="mono meta">{receipt.collectionMethod}</td>
                    <td className="mono meta">{receipt.asOf.slice(0, 10)}</td>
                    <td className="mono meta">{receipt.freshnessStatus}</td>
                    <td className="mono meta">
                      {/* No original is a fact about the receipt, not a blank. */}
                      {receipt.rawHash ? `${receipt.rawHash.slice(0, 10)}…` : "none kept"}
                    </td>
                    <td className="meta">{receipt.limitations.join("; ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {receiptTotal !== null ? (
          <TruncatedNotice
            shown={receipts.length}
            total={receiptTotal}
            noun="source receipts, newest first"
            testId="receipts-truncated"
          />
        ) : null}
      </div>
    );
  };

  const renderClaim = () => {
    return (
      <div className="panel">
        <h2>Claim</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Grades are computed by rule. An operator cannot raise one directly.
        </p>

        {token && canCreateClaim ? <CatalogClaimForm token={token} projectId={id} uploads={uploads} onSaved={load} /> : <p className="meta">A data steward can record catalog claims.</p>}
        <details open><summary>Legacy claim entry (not catalog-backed)</summary>
        <p className="meta">This compatibility action creates an unreviewed mining-right reference. It does not satisfy a catalog requirement.</p>
        <div className="row" style={{ marginBottom: 14 }}>
          <button onClick={() => void addClaim()} disabled={busy}>
            Add a mining right claim
          </button>
        </div></details>

        {claims.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No claims recorded.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Claim type</th>
                  <th>Value</th>
                  <th>Evidence tier</th>
                  <th>Review state</th>
                  <th>Grade</th>
                  <th>Version</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {claims.map((claim) => (
                  <tr key={claim.id}>
                    {/* A claim needs its own address so disputes and review requests point
                            to the same thing. */}
                    <td className="mono">
                      <Link href={`/w/projects/${id}/claims/${claim.id}`}>{claim.claimType}</Link>
                    </td>
                    <td>
                      {claim.valueText}
                      {claim.catalogVersion ? <p className="meta">Catalog v{claim.catalogVersion} · {claim.documentUploadIds?.length ?? 0} linked documents</p> : <p className="meta">Legacy claim · no pinned catalog</p>}
                      {claim.unit ? <span className="meta"> {claim.unit}</span> : null}
                    </td>
                    <td className="mono meta">{claim.evidenceTier ?? "—"}</td>
                    <td className="mono meta">{claim.verificationState}</td>
                    <td>
                      <GradeBadge grade={claim.grade as Grade} />
                    </td>
                    <td className="mono">v{claim.version}</td>
                    <td>
                      <button
                        data-testid={`conflict-${claim.id}`}
                        disabled={busy}
                        onClick={() => void addConflict(claim)}
                      >
                        Record a conflict
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {claimTotal !== null ? (
          <TruncatedNotice
            shown={claims.length}
            total={claimTotal}
            noun="claims, by claim type"
            testId="claims-truncated"
          />
        ) : null}

        <p className="meta" style={{ marginTop: 10 }}>
          Recording a conflict recomputes the grade immediately. If someone changed the claim while
          this screen was open, the record is refused and the current version is reported — so one
          person’s judgement is never quietly overwritten.
        </p>
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Data Room</h1>
          <p className="sub">
            This is a view of claims and their sources, not a file list. A successful source
            lookup is not verification.
          </p>
        </div>
        <Link href={`/w/projects/${id}`}>← Project</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {/*
        Without a scanner, uploads stay in quarantine **forever**. That stall looks
        like waiting, not an error, so unless it is stated here the user believes
        it is still pending.
      */}
      {renderNotice()}

      {renderFiles()}

      {renderSourceReceipt()}

      {renderClaim()}

      {token ? <WorkspaceEvidenceLedger token={token} projectId={id} revision={ledgerRevision} /> : null}

      <p className="meta">
        A successful source lookup is not verification. Each result means something different
        and calls for a different next action.
      </p>
    </>
  );
}

function uploadColor(state: string): string {
  if (state === "promoted") return "var(--positive)";
  if (state === "scanned_infected" || state === "rejected") return "var(--destructive-text)";
  if (state === "scanned_clean") return "var(--foreground)";
  return "var(--alert)";
}
