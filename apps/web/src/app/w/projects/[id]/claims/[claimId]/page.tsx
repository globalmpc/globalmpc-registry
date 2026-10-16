"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { getClaimDetail, type ClaimDetail } from "@/lib/projects-api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { GradeBadge } from "@/components/StatusBadge";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

/**
 * Claim Detail — spec 11 §11.3.
 *
 * A claim used to exist only as a row in the Data Room table. That left **no address
 * for a single claim** — raising a dispute or requesting review meant saying "go to the Data Room
 * and look at this row", and the row gets hard to find as the list grows.
 *
 * The page shows the original statement with unit and source coordinate, the three provenance
 * axes, the attestations that cover it with their limitations, conflicting claims, how a derived
 * value was calculated, its version history and the anchor of any published record holding it.
 *
 * **Grade and verification state are shown together.** Grade is the evidence grade;
 * verification state is whether a person reviewed it. Showing one alone reads as
 * "high grade, so it was reviewed".
 */
export default function ClaimDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string; readonly claimId: string }>;
}) {
  const { id, claimId } = use(params);
  const { token, session, loading: sessionLoading } = useSession();
  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (sessionLoading || !token) return;
    let live = true;
    getClaimDetail(token, claimId)
      .then((detail) => {
        if (!live) return;
        // A claim of another project is not shown under this project's address.
        if (detail.projectId !== id) setMissing(true);
        else setClaim(detail);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        if (caught instanceof ApiError && caught.status === 404) setMissing(true);
        else setError(caught);
      });
    return () => {
      live = false;
    };
  }, [token, sessionLoading, id, claimId]);

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

  const renderClaimDetails = () => {
    if (!claim) return null;
    const renderStatement = () => {
      return (
        <div className="panel" data-testid="claim-detail">
          <h2>Statement</h2>
          <dl className="dl">
            <dt>Value</dt>
            <dd className="mono">
              {claim.valueText}
              {claim.unit ? <span className="meta"> {claim.unit}</span> : null}
            </dd>
            <dt>As of</dt>
            <dd className="mono">{claim.asOf ?? "—"}</dd>
            <dt>Source coordinate</dt>
            <dd className="mono" data-testid="source-coordinate">
              {Object.keys(claim.sourceCoordinate).length === 0
                ? "—"
                : Object.entries(claim.sourceCoordinate)
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(" · ")}
            </dd>
            <dt>Source receipt</dt>
            <dd className="mono">
              {claim.sourceReceiptId ?? <span className="meta">No source receipt is linked</span>}
            </dd>
            <dt>Version</dt>
            <dd className="mono">v{claim.version}</dd>
          </dl>
        </div>
      );
    };

    const renderProvenance = () => {
      return (
        <div className="panel" data-testid="claim-provenance">
          <h2>Provenance</h2>
          <dl className="dl">
            <dt>Evidence tier</dt>
            <dd className="mono">{claim.evidenceTier ?? "—"}</dd>
            <dt>Verification state</dt>
            <dd className="mono">
              {claim.verificationState}
              {claim.verificationState === "unreviewed" ? (
                <div className="meta">No person has reviewed this claim.</div>
              ) : null}
            </dd>
            <dt>Grade</dt>
            <dd>
              <GradeBadge grade={claim.grade} />
            </dd>
            <dt>Stale</dt>
            <dd className="mono">
              {claim.staleSince ? `since ${claim.staleSince}` : "No open signal"}
            </dd>
          </dl>
        </div>
      );
    };

    const renderAttestationsAndLimitations = () => {
      return (
        <div className="panel" data-testid="claim-attestations">
          <h2>Attestations and limitations</h2>
          {claim.attestations.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              No attestation covers this claim.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">State</th>
                    <th scope="col">Limitations</th>
                    <th scope="col">Signed</th>
                    <th scope="col">Valid until</th>
                  </tr>
                </thead>
                <tbody>
                  {claim.attestations.map((attestation) => (
                    <tr key={attestation.id}>
                      <td className="mono">{attestation.attestationType}</td>
                      <td className="mono">{attestation.state}</td>
                      <td>{attestation.limitations}</td>
                      <td className="mono meta">{attestation.signedAt}</td>
                      <td className="mono meta">{attestation.validUntil ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    };

    const renderConflicts = () => {
      return (
        <div className="panel" data-testid="claim-conflicts">
          <h2>Conflicts</h2>
          {claim.conflicts.length === 0 && claim.conflictingClaimIds.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              No conflict is recorded for this claim.
            </p>
          ) : (
            <ul>
              {claim.conflicts.map((item) => (
                <li key={item.id}>
                  <span className="mono">{item.conflictType}</span> ·{" "}
                  {item.resolvedAt ? `resolved ${item.resolvedAt}` : "unresolved"}
                </li>
              ))}
              {claim.conflictingClaimIds.map((other) => (
                <li key={other}>
                  Contradicted by{" "}
                  <Link href={`/w/projects/${id}/claims/${other}`} className="mono">
                    {other.slice(0, 8)}…
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    };

    const renderDerivation = () => {
      return (
        <div className="panel" data-testid="claim-derivation">
          <h2>Derivation</h2>
          {claim.derivation ? (
            <dl className="dl">
              <dt>Formula</dt>
              <dd className="mono">{claim.derivation.formula}</dd>
              <dt>Inputs</dt>
              <dd>
                {claim.derivation.inputClaimIds.map((input) => (
                  <Link key={input} href={`/w/projects/${id}/claims/${input}`} className="mono">
                    {input.slice(0, 8)}…{" "}
                  </Link>
                ))}
              </dd>
              <dt>Unit · as of</dt>
              <dd className="mono">
                {claim.derivation.unit ?? "—"} · {claim.derivation.asOf ?? "—"}
              </dd>
              <dt>Recorded</dt>
              <dd className="mono meta">{claim.derivation.recordedAt}</dd>
            </dl>
          ) : (
            <p className="sub" style={{ margin: 0 }}>
              No derivation is recorded for this claim. If it was calculated, the formula and inputs
              are not on record.
            </p>
          )}
        </div>
      );
    };

    const renderVersionHistory = () => {
      return (
        <div className="panel" data-testid="claim-history">
          <h2>Version history</h2>
          {claim.history.length === 0 && claim.lineage.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              No change has been recorded.
            </p>
          ) : (
            <ul>
              {claim.history.map((row, index) => (
                <li key={`${row.occurredAt}-${index}`}>
                  <span className="mono">{row.command}</span>
                  {row.afterVersion !== null ? (
                    <span className="mono"> → v{row.afterVersion}</span>
                  ) : null}{" "}
                  <span className="meta mono">{row.occurredAt}</span>
                </li>
              ))}
              {claim.lineage
                .filter(
                  (edge) => edge.relationType === "supersedes" || edge.relationType === "revokes",
                )
                .map((edge) => (
                  <li key={`${edge.relationType}-${edge.fromId}-${edge.toId}`}>
                    <span className="mono">{edge.relationType}</span>{" "}
                    <span className="mono meta">
                      {edge.fromId.slice(0, 8)}… → {edge.toId.slice(0, 8)}…
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      );
    };

    const renderAnchorProof = () => {
      return (
        <div className="panel" data-testid="claim-anchor">
          <h2>Anchor proof</h2>
          {claim.anchors.length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>
              No published registry record containing this claim has been anchored.
            </p>
          ) : (
            <ul>
              {claim.anchors.map((anchor) => (
                <li key={anchor.entryVersionId}>
                  <span className="mono">{anchor.merkleRoot ?? "not in a batch yet"}</span> ·{" "}
                  <span className="mono">{anchor.txHash ?? "no transaction"}</span> ·{" "}
                  {anchor.transactionState ?? "—"}
                </li>
              ))}
            </ul>
          )}
          <p className="meta" style={{ marginBottom: 0 }}>
            An anchor proves that the published bytes were included and not altered. It does not prove
            that the value is true or legally effective.
          </p>
        </div>
      );
    };

    return (
      <>
        {renderStatement()}

        {renderProvenance()}

        <div className="notice" style={{ color: "var(--alert)" }}>
          <div className="title">Grade is not review</div>
          {REQUIRED_BOUNDARY_COPY.verification} A grade describes the evidence behind a value. It does
          not say that a qualified person examined it, and it never says the value is correct.
        </div>

        {renderAttestationsAndLimitations()}

        {renderConflicts()}

        {renderDerivation()}

        {renderVersionHistory()}

        {renderAnchorProof()}
      </>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{claim ? claim.claimType : "Claim"}</h1>
          <p className="sub">
            A single recorded claim, its grade, and whether a person has reviewed it. Those are two
            different facts.
          </p>
        </div>
        <Link href={`/w/projects/${id}/data-room`}>← Data Room</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {missing ? (
        <div className="panel">
          <p className="sub" style={{ margin: 0 }}>
            {/* Distinguish not found from no permission (§11.7). */}
            No claim with this id exists in this project. If you expected one, it may belong to a
            different project — this is not a permission problem.
          </p>
        </div>
      ) : null}

      {renderClaimDetails()}
    </>
  );
}
