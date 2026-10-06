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
 * Anchor state — spec 08 §8.9, 06 §6.8.
 *
 * Shows what happened after a batch was created. Without it, an operator cannot
 * tell a stuck submission from one awaiting confirmation.
 *
 * **States are not collapsed into "in progress/done".** `included` and `confirmed` are different
 * facts, and the difference sets the `included` field of the public proof.
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
    // The worker changes chain state externally. Without periodic re-reads the screen
    // still shows "submitting" after confirmation.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, sessionLoading]);

  /**
   * Resubmit a stuck batch.
   *
   * Why this is not automatic: submitting the same root twice is rejected by the contract
   * with `BatchAlreadyExists`, but gas is still spent. A person who has checked the cause
   * decides.
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
          {/* This state does not clear on its own. Left silent, the public record stands without evidence. */}
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
            {/* Automatic resubmission could submit the same root twice. */}
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
                        // Keep included from reading as success (06 §6.8).
                        <div className="meta">Not confirmed yet</div>
                      ) : null}
                      {item.proposal ? (
                        // A proposal existing does not mean it was submitted. Collecting signatures
                        // and executing happen in Safe, by people.
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
                        // Even after reconfirmation, the fact that it was reorged once is kept.
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
