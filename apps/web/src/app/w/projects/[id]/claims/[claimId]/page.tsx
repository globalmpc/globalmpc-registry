"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import {
  listClaims,
  listSourceReceipts,
  type Claim,
  type SourceReceipt,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

/**
 * Claim Detail — spec 11 §11.3.
 *
 * A claim used to exist only as a row in the Data Room table. That left **no address
 * for a single claim** — raising a dispute or requesting review meant saying "go to the Data Room
 * and look at this row", and the row gets hard to find as the list grows.
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
  const [claim, setClaim] = useState<Claim | null>(null);
  const [receipts, setReceipts] = useState<SourceReceipt[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (sessionLoading || !token) return;
    let live = true;
    Promise.all([listClaims(token, id), listSourceReceipts(token, id)])
      .then(([claimPage, receiptPage]) => {
        if (!live) return;
        setClaim(claimPage.items.find((item) => item.id === claimId) ?? null);
        setReceipts(receiptPage.items);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [token, sessionLoading, id, claimId]);

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

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

      {loaded && !claim ? (
        <div className="panel">
          <p className="sub" style={{ margin: 0 }}>
            {/* Distinguish not found from no permission (§11.7). */}
            No claim with this id exists in this project. If you expected one, it may belong to a
            different project — this is not a permission problem.
          </p>
        </div>
      ) : null}

      {claim ? (
        <>
          <div className="panel" data-testid="claim-detail">
            <dl className="dl">
              <dt>Value</dt>
              <dd className="mono">
                {claim.valueText}
                {claim.unit ? <span className="meta"> {claim.unit}</span> : null}
              </dd>
              <dt>As of</dt>
              <dd className="mono">{claim.asOf ?? "—"}</dd>
              <dt>Evidence tier</dt>
              <dd className="mono">{claim.evidenceTier ?? "—"}</dd>
              <dt>Grade</dt>
              <dd className="mono">{claim.grade}</dd>
              <dt>Verification state</dt>
              <dd className="mono">
                {claim.verificationState}
                {claim.verificationState === "unreviewed" ? (
                  <div className="meta">No person has reviewed this claim.</div>
                ) : null}
              </dd>
              <dt>Version</dt>
              <dd className="mono">v{claim.version}</dd>
            </dl>
          </div>

          <div className="notice" style={{ color: "var(--alert)" }}>
            <div className="title">Grade is not review</div>
            {REQUIRED_BOUNDARY_COPY.verification.en} A grade describes the evidence behind a value.
            It does not say that a qualified person examined it, and it never says the value is
            correct.
          </div>

          <div className="panel">
            <h2>Sources recorded for this project</h2>
            <p className="sub" style={{ marginTop: 0 }}>
              {REQUIRED_BOUNDARY_COPY.sourceStatus.en}
            </p>
            {receipts.length === 0 ? (
              <p className="sub" style={{ margin: 0 }}>
                No source has been queried for this project.
              </p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Result</th>
                      <th>Method</th>
                      <th>Freshness</th>
                      <th>As of</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipts.map((receipt) => (
                      <tr key={receipt.id}>
                        <td className="mono">
                          {receipt.result}
                          {/* State next to the result that success is not verification. */}
                          {receipt.permitsCanonicalAcceptance ? null : (
                            <div className="meta" style={{ color: "var(--alert)" }}>
                              cannot be accepted as canonical
                            </div>
                          )}
                        </td>
                        <td className="mono">{receipt.collectionMethod}</td>
                        <td className="mono">{receipt.freshnessStatus}</td>
                        <td className="mono meta">{receipt.asOf}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
