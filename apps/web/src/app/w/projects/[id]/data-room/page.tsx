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
  type Claim,
  type DocumentNode,
  type ObjectUpload,
  type ScannerStatus,
  type SourceReceipt,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { GradeBadge, SourceResultBadge } from "@/components/StatusBadge";
import { validityText } from "@/lib/documents";
import { PHOTO_ACCEPT, UPLOAD_ACCEPT } from "@/lib/uploads";
import type { Grade, SourceResult } from "@mpc/domain";

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
  const { token, loading: sessionLoading } = useSession();

  const [receipts, setReceipts] = useState<SourceReceipt[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [uploads, setUploads] = useState<ObjectUpload[]>([]);
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);
  // Open impacts and server-side day counts per document. The upload list itself does not
  // carry them — they depend on links, not on the file.
  const [nodes, setNodes] = useState<Record<string, DocumentNode>>({});
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [receiptData, claimData, uploadData, graphData] = await Promise.all([
        listSourceReceipts(token, id),
        listClaims(token, id),
        listUploads(token, id),
        getDocumentGraph(token, id),
      ]);
      setReceipts(receiptData.items);
      setClaims(claimData.items);
      setUploads(uploadData.items);
      setScanner(uploadData.scanner);
      setNodes(Object.fromEntries(graphData.nodes.map((node) => [node.uploadId, node])));
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

  /**
   * **Actually calls** the official source — 2026-09-10 audit A1.
   *
   * This screen used to send `confirmed_from_source` directly. That turned the meaning of
   * confirmation from "we checked" into **"the uploader said so"**. Confirmation
   * comes only from the answer the server gets by calling the source — if it cannot answer, that fact is recorded.
   */
  async function lookUpSource() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await collectFromSource(
        token,
        DEMO_CONNECTION_ID,
        id,
        { licenseNumber: "MV-012345" },
        newIdempotencyKey(),
      );
      await load();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function addReceipt(result: string) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await createSourceReceipt(
        token,
        id,
        {
          connectionId: DEMO_CONNECTION_ID,
          authorityId: DEMO_AUTHORITY_ID,
          result,
          collectionMethod: "authenticated_api",
          queryBasis: { licenseNumber: "MV-012345" },
          endpointOrDocumentRef: "https://registry.example/api/licenses/MV-012345",
          authenticationMethod: "mtls+oauth2",
          rawHash: `0x${"ab".repeat(32)}`,
          sourceSchemaVersion: "2026-01",
          adapterVersion: "1.0.0",
          termsLicense: "data sharing agreement 2026-01",
          commercialReuse: "unconfirmed",
          disclosurePermission: "restricted",
          asOf: new Date().toISOString(),
          freshnessStatus: "fresh",
          limitations: ["This lookup confirms mining right registration status only"],
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
          verificationState: "analyst_checked",
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
      {scanner && scanner.state !== "running" ? (
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
                : "Scan worker state is unknown"}
          </div>
          {scanner.state === "unknown"
            ? "We could not read the scanner's state. Treat quarantined uploads as unverified until this resolves."
            : "Uploads will stay in quarantine and cannot be promoted to evidence until a scanner runs. This is not a queue you can wait out."}
          {scanner.secondsSinceHeartbeat !== null ? (
            <div className="meta" style={{ marginTop: 6, color: "inherit" }}>
              Last seen {scanner.secondsSinceHeartbeat}s ago.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2>Files</h2>
          <Link href={`/w/projects/${id}/impacts`} data-testid="impacts-link">
            Documents that need a second look →
          </Link>
        </div>
        <p className="sub" style={{ marginTop: 0 }}>
          {/* If uploads became evidence immediately, unscanned files would become review material. */}
          An uploaded file does not become evidence on arrival. It enters quarantine, and only
          after the scan worker finishes can it be promoted to evidence.
        </p>

        {/* Two inputs, not one: the camera is offered only where a photo is meant. Forcing it on
            the general picker would stop people on a phone from attaching a saved file. */}
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

        {uploads.length === 0 ? (
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
              <tbody>
                {uploads.map((upload) => (
                  <tr key={upload.id}>
                    <td className="meta">{upload.originalFilename ?? "—"}</td>
                    <td className="meta">{upload.documentType ?? "—"}</td>
                    <td
                      className="mono meta"
                      data-testid={`upload-validity-${upload.id}`}
                      style={
                        nodes[upload.id]?.expired ? { color: "var(--destructive-text)" } : undefined
                      }
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
                      {nodes[upload.id]?.openImpactCount ?? 0}
                    </td>
                    <td className="meta">{upload.nextActions.join(", ") || "—"}</td>
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
                                promoteUpload(
                                  activeToken,
                                  upload.id,
                                  upload.version,
                                  newIdempotencyKey(),
                                ),
                              )
                            }
                          >
                            Promote to evidence
                          </button>
                        ) : null}

                        {/* Only scanned files get a link (Q-033). The server refuses the rest. */}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="meta" style={{ marginTop: 10 }}>
          {/* No path reverses an infected verdict — enforced by the state machine, not permissions. */}
          A separate worker runs the scan; this screen cannot produce the result. A file judged
          infected cannot be rescanned and is never promoted to evidence — upload it again as a
          new file. Only a file that passed the scan can be downloaded. Download links expire
          after five minutes, and anyone holding one can fetch
          the file without signing in.
        </p>
      </div>

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
          A confirmation is not something this screen can record. It comes from the server
          calling the official source, or from a signed document the server verified against a
          registered key. The buttons below record what actually happened.
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <button onClick={() => void lookUpSource()} disabled={busy}>
            Look up the official source
          </button>
          <button onClick={() => void addReceipt("source_returned_no_record")} disabled={busy}>
            Record “no record”
          </button>
          <button onClick={() => void addReceipt("source_unavailable")} disabled={busy}>
            Record “source unavailable”
          </button>
        </div>

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
                    <td className="meta">{receipt.limitations.join("; ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Claim</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          Grades are computed by rule. An operator cannot raise one directly.
        </p>

        <div className="row" style={{ marginBottom: 14 }}>
          <button onClick={() => void addClaim()} disabled={busy}>
            Add a mining right claim
          </button>
        </div>

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

        <p className="meta" style={{ marginTop: 10 }}>
          Recording a conflict recomputes the grade immediately. If someone changed the claim
          while this screen was open, the record is refused and the current version is reported —
          so one person’s judgement is never quietly overwritten.
        </p>
      </div>

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

/** Demo authority and connection created by seed. Replaced by the real Mongolia profile in R5. */
const DEMO_AUTHORITY_ID = "cccccccc-0000-0000-0000-000000000001";
const DEMO_CONNECTION_ID = "cccccccc-0000-0000-0000-000000000002";
