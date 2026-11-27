"use client";

import { PublicProjectHeader } from "@/components/PublicProjectHeader";
import { use, useEffect, useState } from "react";
import { getPublicRegistryEntry, type PublicProjection } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PublicRecord } from "@/components/PublicRecord";
import type { LedgerSummary } from "@/lib/evidence-ledger-api";

/**
 * Shareable public project URL — spec 11 §11.3.
 *
 * Sending a public record to someone used to require saying "go to Explorer and enter this key".
 * The link must be the record so citations, audits, and disputes point to the same thing.
 *
 * **This screen creates no new data.** Fields outside the public projection are not returned
 * by the server, and they are not filled in here from another endpoint.
 */
export default function PublicProjectPage({
  params,
}: {
  readonly params: Promise<{ readonly publicKey: string }>;
}) {
  const { publicKey } = use(params);
  return <PublicProjectDetail key={publicKey} publicKey={publicKey} />;
}

function PublicProjectDetail({ publicKey }: { readonly publicKey: string }) {
  const [entry, setEntry] = useState<PublicProjection | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    void getPublicRegistryEntry("project", decodeURIComponent(publicKey))
      .then((found) => {
        if (live) setEntry(found);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [publicKey]);

  return (
    <>
      <PublicProjectHeader key={publicKey} entry={entry} publicKey={publicKey} />

      {error ? <ErrorNotice error={error} /> : null}

      {busy && !entry ? <p className="sub">Loading…</p> : null}

      {entry ? (
        <div className="public-project-detail">
          <ProjectSummary entry={entry} publicKey={publicKey} />
          <div className="public-project-record">
            <PublicRecord key={entry.entryVersionId} entry={entry} browsableEvidence />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ProjectSummary({
  entry,
  publicKey,
}: {
  readonly entry: PublicProjection;
  readonly publicKey: string;
}) {
  const ledger = entry.evidenceLedger as LedgerSummary | undefined;
  const hasSignedReviews = ledger?.items.some((item) => item.reviews?.length);
  const mineral = Array.isArray(entry.mineral)
    ? entry.mineral.filter((value) => typeof value === "string").join(", ")
    : "";

  return (
    <aside className="panel public-project-summary" aria-labelledby="project-summary-title">
      <h2 id="project-summary-title">Project summary</h2>
      <dl className="dl">
        <dt>Project</dt>
        <dd>{typeof entry.projectName === "string" ? entry.projectName : publicKey}</dd>
        <dt>Published status</dt>
        <dd className={`state-label${entry.revokedAt || entry.status === "revoked" ? " state-rejected" : ""}`}>
          {entry.revokedAt ? "revoked" : entry.status}
        </dd>
        {typeof entry.hostCountry === "string" ? (
          <><dt>Host country</dt><dd>{entry.hostCountry}</dd></>
        ) : null}
        {mineral ? <><dt>Minerals</dt><dd>{mineral}</dd></> : null}
        <dt>Signed evidence reviews</dt>
        <dd>{hasSignedReviews ? "Included in this version" : "None listed in this version"}</dd>
      </dl>
    </aside>
  );
}
