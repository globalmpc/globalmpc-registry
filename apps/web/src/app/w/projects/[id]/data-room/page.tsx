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
  type Claim,
  type ObjectUpload,
  type ScannerStatus,
  type SourceReceipt,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { GradeBadge, SourceResultBadge } from "@/components/StatusBadge";
import type { Grade, SourceResult } from "@mpc/domain";

/**
 * Data Room — spec 11 §11.3.
 *
 * 폴더가 아니라 **claim/evidence 중심 view**다. 파일 목록이 아니라 "무엇이
 * 어떤 출처로 확인됐는가"를 보여준다.
 *
 * 12개 source result가 각자 다른 배지와 다음 행동을 갖는 것이 핵심이다 —
 * "기록 없음"과 "확인 불가"가 같아 보이면 사용자는 존재하지 않는 기록을 계속
 * 재시도한다(AC-18).
 */
export default function DataRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token, loading: sessionLoading } = useSession();

  const [receipts, setReceipts] = useState<SourceReceipt[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [uploads, setUploads] = useState<ObjectUpload[]>([]);
  const [scanner, setScanner] = useState<ScannerStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [receiptData, claimData, uploadData] = await Promise.all([
        listSourceReceipts(token, id),
        listClaims(token, id),
        listUploads(token, id),
      ]);
      setReceipts(receiptData.items);
      setClaims(claimData.items);
      setUploads(uploadData.items);
      setScanner(uploadData.scanner);
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
   * 공식 출처를 **실제로 부른다** — 2026-09-10 실사 A1.
   *
   * 예전에는 이 화면이 `confirmed_from_source`를 직접 보냈다. 그러면 확정의 뜻이
   * "우리가 확인했다"가 아니라 **"올린 사람이 그렇다고 했다"**가 된다. 확정은
   * 서버가 출처를 불러 받은 답에서만 나온다 — 답하지 못하면 그 사실이 남는다.
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
   * 충돌 기록.
   *
   * 이 claim의 현재 version을 함께 보낸다. 목록을 띄워 둔 사이 다른 사람이 먼저
   * 바꿨으면 서버가 412로 거절하고, 화면은 그 사실을 그대로 보여준다.
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

  /** 파일을 올린다. 올린 것은 evidence가 아니라 quarantine에 들어간다. */
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
   * 토큰이 필요한 동작을 한 곳에서 감싼다.
   *
   * 토큰을 인자로 넘기는 이유: 렌더 시점의 `token`은 세션 로딩 중 null일 수 있다.
   * 호출부마다 확인하면 한 곳에서 빠뜨린다.
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
        검사기가 없으면 업로드는 quarantine에 **영원히** 머문다. 그 정지는
        오류가 아니라 대기처럼 보이므로, 여기서 말하지 않으면 사용자는 기다리는
        중이라고 믿는다.
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
        <h2>Files</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          {/* 업로드 즉시 evidence가 되면 검사되지 않은 파일이 검토 대상 자료가 된다. */}
          An uploaded file does not become evidence on arrival. It enters quarantine, and only
          after the scan worker finishes can it be promoted to evidence.
        </p>

        <div className="field">
          <label htmlFor="upload">Choose a file</label>
          <input
            id="upload"
            type="file"
            data-testid="upload-input"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void addUpload(file);
              event.target.value = "";
            }}
          />
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
                  <th>State</th>
                  <th>Size</th>
                  <th>Next action</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {uploads.map((upload) => (
                  <tr key={upload.id}>
                    <td className="meta">{upload.originalFilename ?? "—"}</td>
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
                    <td className="meta">{upload.nextActions.join(", ") || "—"}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {upload.state === "quarantined" ? (
                          // 검사는 별도 worker가 한다. 화면에서 결과를 만들 수
                          // 있으면 격리가 형식만 남는다.
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

                        {upload.state !== "scanned_infected" ? (
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
          {/* 감염 판정을 되돌리는 경로는 존재하지 않는다 — 권한이 아니라 상태기계다. */}
          A separate worker runs the scan; this screen cannot produce the result. A file judged
          infected cannot be rescanned and is never promoted to evidence — upload it again as a
          new file. Download links expire after five minutes, and anyone holding one can fetch
          the file without signing in.
        </p>
      </div>

      <div className="panel">
        <h2>Source Receipt</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          The twelve results are different facts. Each carries a different next action.
        </p>
        {/*
          확정을 화면에서 적어 넣을 수 없다는 것을 사람이 읽을 수 있게 적는다.
          버튼만 없애면 "왜 없나"를 알 수 없고, 그러면 우회 경로를 찾게 된다.
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
                      {/* 재시도 여부를 사용자가 추측하지 않게 한다. */}
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
                    {/* claim 하나를 가리킬 주소가 있어야 이의·검토 요청이 같은
                        것을 가리킨다. */}
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

/** seed가 만든 데모 authority·connection. R5에서 실제 Mongolia profile로 대체한다. */
const DEMO_AUTHORITY_ID = "cccccccc-0000-0000-0000-000000000001";
const DEMO_CONNECTION_ID = "cccccccc-0000-0000-0000-000000000002";
