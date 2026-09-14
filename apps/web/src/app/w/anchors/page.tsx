"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  listAnchorBatches,
  newIdempotencyKey,
  resubmitAnchorBatch,
  type AnchorBatchStatus,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Address } from "@/components/Address";

/**
 * Anchor 상태 — spec 08 §8.9, 06 §6.8.
 *
 * batch를 만든 뒤 무슨 일이 일어났는지 보는 화면이다. 이것이 없으면 운영자는
 * 제출이 막힌 것과 확정을 기다리는 것을 구분할 수 없다.
 *
 * **상태를 "진행중/완료"로 뭉개지 않는다.** `included`와 `confirmed`는 다른
 * 사실이고, 그 차이가 공개 증명의 `included` 필드를 결정한다.
 */
export default function AnchorsPage() {
  const { token, loading: sessionLoading } = useSession();
  const [items, setItems] = useState<AnchorBatchStatus[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const data = await listAnchorBatches(token);
      setItems(data.items);
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (sessionLoading) return;
    void load();
    // 체인 상태는 worker가 밖에서 바꾼다. 화면이 주기적으로 다시 읽지 않으면
    // 확정된 뒤에도 제출 중으로 보인다.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, sessionLoading]);

  /**
   * 멈춘 batch를 다시 올린다.
   *
   * 자동으로 하지 않는 이유: 같은 root를 두 번 올리면 컨트랙트가
   * `BatchAlreadyExists`로 거절하지만 가스는 소모된다. 원인을 확인한 사람이
   * 결정한다.
   */
  async function resubmit(batchId: string) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await resubmitAnchorBatch(token, batchId, newIdempotencyKey());
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

  const attention = items.filter((item) => item.needsAttention);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Anchor status</h1>
          <p className="sub">
            Where each batch stands between submission and confirmation. Inclusion in a block
            and confirmation are different facts.
          </p>
        </div>
        <Link href="/w/projects">← Projects</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {attention.length > 0 ? (
        <div className="notice" data-testid="anchor-attention" style={{ color: "var(--destructive-text)" }}>
          <div className="title">{attention.length} batches need a person to look</div>
          {/* 자동으로 풀리지 않는 상태다. 조용히 두면 공개 기록이 근거 없이 남는다. */}
          <ul>
            {attention.map((item) => (
              <li key={item.id}>
                <span className="mono">{item.batchId.slice(0, 18)}…</span> —{" "}
                {item.confirmationState}
                {item.lastError ? <span className="meta"> · {item.lastError}</span> : null}
              </li>
            ))}
          </ul>
          <div className="meta" style={{ marginTop: 6 }}>
            {/* 자동 재제출은 같은 root를 두 번 올릴 수 있다. */}
            Resubmission is never automatic. A person decides after finding the cause.
          </div>
        </div>
      ) : null}

      <div className="panel">
        {loading ? (
          <p className="sub">Loading…</p>
        ) : items.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            There are no anchor batches. There is no data here; this is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table data-testid="anchor-table">
              <thead>
                <tr>
                  <th>batch</th>
                  <th>Chain state</th>
                  <th>Confirmations</th>
                  <th>Records</th>
                  <th>Block</th>
                  <th>Attempts</th>
                  <th>reorg</th>
                  <th>Last error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="mono meta">{item.batchId.slice(0, 14)}…</td>
                    <td>
                      <span
                        className="mono"
                        style={{ color: stateColor(item.confirmationState) }}
                        data-testid={`anchor-state-${item.batchId.slice(2, 10)}`}
                      >
                        {item.confirmationState}
                      </span>
                      {item.confirmationState === "included" ? (
                        // included를 성공으로 읽지 않게 한다(06 §6.8).
                        <div className="meta">Not confirmed yet</div>
                      ) : null}
                      {item.proposal ? (
                        // 제안이 있다는 것은 제출됐다는 뜻이 아니다. 서명 수집과
                        // 실행은 Safe에서 사람이 한다.
                        <div className="meta" data-testid="safe-proposal">
                          Awaiting Safe signatures ·{" "}
                          <Address value={item.proposal.safeAddress} label="Safe address" />
                          <div>calldata {item.proposal.calldataHash.slice(0, 14)}…</div>
                        </div>
                      ) : null}
                    </td>
                    <td className="mono">{item.confirmations}</td>
                    <td className="mono">{item.recordCount}</td>
                    <td className="mono meta">{item.blockNumber ?? "—"}</td>
                    <td className="mono">{item.attempts}</td>
                    <td className="mono">
                      {item.reorgCount > 0 ? (
                        // 재확정됐더라도 한 번 뒤집혔다는 사실은 지우지 않는다.
                        <span style={{ color: "var(--alert)" }}>{item.reorgCount}</span>
                      ) : (
                        <span className="meta">0</span>
                      )}
                    </td>
                    <td className="meta">{item.lastError ?? "—"}</td>
                    <td>
                      {item.needsAttention ? (
                        <button
                          data-testid={`resubmit-${item.batchId.slice(2, 10)}`}
                          disabled={busy}
                          onClick={() => void resubmit(item.id)}
                        >
                          Resubmit
                        </button>
                      ) : (
                        <span className="meta">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="notice" style={{ color: "var(--alert)" }}>
        <div className="title">What confirmation means</div>
        Confirmation means this batch’s root is on chain. It does not mean the records inside
        it are true. The factual accuracy of a source and the standing of a reviewer are
        established on other grounds.
      </div>
    </>
  );
}

function stateColor(state: string): string {
  if (state === "confirmed") return "var(--positive)";
  if (state === "included" || state === "submitted" || state === "proposed") {
    return "var(--alert)";
  }
  if (["failed", "reverted", "dropped", "reconciliation_required"].includes(state)) {
    return "var(--destructive-text)";
  }
  return "var(--muted-foreground)";
}
