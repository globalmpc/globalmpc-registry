"use client";

import { useEffect, useState } from "react";
import { TxLink } from "@/components/TxLink";
import {
  getInclusionProof,
  type InclusionProof,
  type PublicProjection,
} from "@/lib/api";
import { project, type RecordDepth, type RecordView } from "@mpc/ui";

/**
 * One published public record — spec 11 §11.3·§11.10 / AC-26.
 *
 * Explorer search results and the shareable project URL (`/explorer/projects/[key]`)
 * must show the same thing. If each screen renders its own, limitations go missing on one side
 * and nobody catches it by eye.
 *
 * Displaying two questions separately is the core of this component (08 §8.11).
 *
 * 1. Was this public version included in the batch — Merkle proof and chain finality
 * 2. Was this source/reviewer an appropriate authority for that judgment — off-chain Registry
 *
 * Success on 1 does not guarantee 2.
 */
export function PublicRecord({ entry }: { readonly entry: PublicProjection }) {
  const [proof, setProof] = useState<InclusionProof | null>(null);
  const [depth, setDepth] = useState<RecordDepth>("basic");

  // The proof may not be anchored yet. Absence is not an error, so a lookup
  // failure is not raised as a screen error; it is stated as "not yet available".
  useEffect(() => {
    let live = true;
    setProof(null);
    void getInclusionProof(entry.entryVersionId)
      .then((found) => {
        if (live) setProof(found);
      })
      .catch(() => {
        if (live) setProof(null);
      });
    return () => {
      live = false;
    };
  }, [entry.entryVersionId]);

  const view = toRecordView(entry, proof);
  // @mpc/ui selects fields per depth. If the screen picks them, limitations
  // go missing at some depth (AC-26).
  const shown = project(view, depth) as Record<string, unknown>;

  return (
      <>
        <div className="panel">
          <div className="page-head" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>Published record</h2>
            {/*
              Three-depth record view — §11.10 / AC-26.

              Depth **only shows more, never less.** status, as-of, version,
              limitations, and authority scope stay at every depth. That keeps the state read in
              "Simple view" and the state read in "Detailed view"
              from diverging.
            */}
            <div className="row" style={{ gap: 6 }} data-testid="depth-switch">
              {(["basic", "explanation", "expert"] as const).map((option) => (
                <button
                  key={option}
                  data-testid={`depth-${option}`}
                  className={depth === option ? "primary" : undefined}
                  aria-pressed={depth === option}
                  onClick={() => setDepth(option)}
                >
                  {DEPTH_LABEL[option]}
                </button>
              ))}
            </div>
          </div>

          {/* Facts that never collapse at any depth. */}
          <dl className="dl" data-testid="shared-facts">
            <dt>Status</dt>
            <dd className="mono" data-testid="shared-status">
              {view.shared.status}
            </dd>
            <dt>Version</dt>
            <dd className="mono" data-testid="shared-version">
              {view.shared.version}
            </dd>
            <dt>As of</dt>
            <dd className="mono" data-testid="shared-as-of">
              {view.shared.asOf}
            </dd>
            <dt>Legal effect</dt>
            <dd className="mono">{String(entry.legalEffect)}</dd>
            {entry.revokedAt ? (
              <>
                <dt>Revoked at</dt>
                <dd className="mono" style={{ color: "var(--destructive-text)" }}>
                  {entry.revokedAt}
                </dd>
              </>
            ) : null}
          </dl>

          <h2 style={{ marginTop: 18 }}>Authority scope</h2>
          <ul
            style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}
            data-testid="shared-authority-scope"
          >
            {view.shared.authorityScope.length > 0 ? (
              view.shared.authorityScope.map((scope) => <li key={scope}>{scope}</li>)
            ) : (
              <li>The published record states no authority scope.</li>
            )}
          </ul>

          <h2 style={{ marginTop: 18 }}>Limits of this review</h2>
          <ul
            style={{ margin: 0, paddingLeft: 18, color: "var(--muted-foreground)" }}
            data-testid="shared-limitations"
          >
            {view.shared.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>

          {"proves" in shown ? (
            <div data-testid="explanation-layer">
              <div className="row" style={{ marginTop: 18, alignItems: "flex-start", gap: 24 }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <h2 style={{ fontSize: 13 }}>What this authority establishes</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--positive)" }}>
                    {view.explanation.proves.length > 0 ? (
                      view.explanation.proves.map((item) => <li key={item}>{item}</li>)
                    ) : (
                      <li>Nothing has been anchored for this version yet.</li>
                    )}
                  </ul>
                </div>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <h2 style={{ fontSize: 13 }}>What it does not establish</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--alert)" }}>
                    {view.explanation.doesNotProve.length > 0 ? (
                      view.explanation.doesNotProve.map((item) => <li key={item}>{item}</li>)
                    ) : (
                      <li>Factual accuracy, reviewer standing, and legal effect.</li>
                    )}
                  </ul>
                </div>
              </div>
              <p className="meta" style={{ marginTop: 12 }}>
                {view.explanation.freshnessExplanation}
              </p>
            </div>
          ) : null}

          {"rawHashReference" in shown ? (
            <div data-testid="expert-layer">
              <h2 style={{ marginTop: 18 }}>Receipt and integrity detail</h2>
              <dl className="dl">
                <dt>Record ID</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.shared.recordId}
                </dd>
                <dt>Authority</dt>
                <dd className="mono">{view.expert.authorityId}</dd>
                <dt>Query or document</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.expert.queryOrDocumentReference}
                </dd>
                <dt>Received at</dt>
                <dd className="mono">{view.expert.receivedAt}</dd>
                <dt>Leaf hash</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.expert.rawHashReference}
                </dd>
                <dt>Source schema version</dt>
                <dd className="mono">{view.expert.sourceSchemaVersion}</dd>
                <dt>Adapter version</dt>
                <dd className="mono">{view.expert.adapterVersion}</dd>
                <dt>Policy version</dt>
                <dd className="mono">{view.expert.policyVersion ?? "—"}</dd>
                <dt>Merkle path</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {view.expert.merklePath?.length
                    ? view.expert.merklePath.join(" · ")
                    : "Not anchored yet"}
                </dd>
                <dt>Transaction</dt>
                <dd>
                  <TxLink chainId={proof?.chainId ?? null} hash={view.expert.transactionHash ?? null} />
                </dd>
              </dl>
            </div>
          ) : null}
        </div>

        {entry.history.length > 0 ? (
          <div className="panel">
            <h2>Earlier versions</h2>
            {/* Do not hide correction/revocation history. Same reason as not making a past
                state look current (§11.6). */}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Status</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.history.map((version) => (
                    <tr key={version.entryVersionId}>
                      <td className="mono">v{version.version}</td>
                      <td className="mono">{version.status}</td>
                      <td className="mono meta">{version.entryVersionId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="panel" data-testid="proof-panel">
          <h2>Integrity proof</h2>
          {proof ? (
            <>
              <dl className="dl">
                <dt>Merkle check</dt>
                <dd>
                  {proof.merkleVerified ? (
                    <span style={{ color: "var(--positive)" }}>Path matches</span>
                  ) : (
                    <span style={{ color: "var(--destructive-text)" }}>Does not match</span>
                  )}
                </dd>
                <dt>Chain confirmation state</dt>
                <dd className="mono">{proof.confirmationState}</dd>
                <dt>Inclusion confirmed</dt>
                <dd data-testid="proof-included">
                  {proof.included ? (
                    <span style={{ color: "var(--positive)" }}>Confirmed</span>
                  ) : (
                    // included is true only when confirmed. Before that it is not yet
                    // final (06 §6.8 no hidden success).
                    <span style={{ color: "var(--alert)" }}>
                      Not confirmed yet — shown once the chain confirms
                    </span>
                  )}
                </dd>
                <dt>root</dt>
                <dd className="mono" style={{ wordBreak: "break-all" }}>
                  {proof.root}
                </dd>
                <dt>Transaction</dt>
                <dd>
                  <TxLink chainId={proof.chainId} hash={proof.transactionHash} />
                </dd>
              </dl>

              <div className="row" style={{ marginTop: 14, alignItems: "flex-start", gap: 24 }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <h2 style={{ fontSize: 13 }}>What this proof confirms</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--positive)" }}>
                    {proof.proves.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div style={{ flex: 1, minWidth: 240 }} data-testid="proof-disclaimer">
                  <h2 style={{ fontSize: 13 }}>What it does not confirm</h2>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--alert)" }}>
                    {proof.doesNotProve.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          ) : (
            <p className="sub" style={{ margin: 0 }}>
              Not anchored yet. An integrity proof exists only after a batch is built.
            </p>
          )}
        </div>

        <div className="notice" style={{ color: "var(--alert)" }}>
          <div className="title">Integrity and authority are different questions</div>
          The proof confirms that this record has not changed. It does not judge whether the
          source is factually accurate or whether the reviewer was qualified. Those are
          established on separate grounds.
        </div>
      </>
  );
}

const DEPTH_LABEL: Record<RecordDepth, string> = {
  basic: "Basic",
  explanation: "Explanation",
  expert: "Expert",
};

/** Optional fields of the public projection. Read only within the `.strict()` allowlist. */
function optionalString(entry: PublicProjection, key: string): string | null {
  const value = entry[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStrings(entry: PublicProjection, key: string): readonly string[] {
  const value = entry[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Maps the public response to the three-depth view.
 *
 * **Never fabricate missing values.** Before anchoring there is no merkle path or transaction,
 * and the screen states "not yet available" — filling gaps with plausible values turns
 * the Expert depth into decoration instead of evidence.
 */
function toRecordView(entry: PublicProjection, proof: InclusionProof | null): RecordView {
  const asOf = entry.publishedAt ?? optionalString(entry, "asOf") ?? "—";
  const staleStatus = optionalString(entry, "staleStatus");
  const sourceAge = optionalString(entry, "sourceAge");

  return {
    shared: {
  recordId: entry.entryVersionId,
  version: `v${entry.version}`,
  status: entry.status,
  asOf,
  limitations: entry.limitations,
  authorityScope: optionalStrings(entry, "authorityScope"),
    },
    explanation: {
  proves: proof ? proof.proves : [],
  doesNotProve: proof ? proof.doesNotProve : [],
  freshnessExplanation: staleStatus
    ? `Source freshness: ${staleStatus}${sourceAge ? ` · age ${sourceAge}` : ""}. As of ${asOf}.`
    : `As of ${asOf}. The published record states no freshness status.`,
    },
    expert: {
  authorityId: optionalString(entry, "authorityType") ?? "—",
  queryOrDocumentReference: proof ? `batch ${proof.batchId}` : "—",
  receivedAt: entry.publishedAt ?? "—",
  rawHashReference: proof?.leafHash ?? "—",
  // Not in the public projection allowlist. Do not substitute a similar field.
  sourceSchemaVersion: "—",
  adapterVersion: "—",
  signature: null,
  attestationVersion: null,
  policyVersion: null,
  merklePath: proof ? proof.proof : null,
  transactionHash: proof?.transactionHash ?? null,
    },
  };
}
