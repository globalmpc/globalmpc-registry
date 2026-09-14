"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { getPublicRegistryEntry, type PublicProjection } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PublicRecord } from "@/components/PublicRecord";

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
  const [entry, setEntry] = useState<PublicProjection | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    setBusy(true);
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
      <div className="page-head">
        <div>
          <h1 className="mono">{decodeURIComponent(publicKey)}</h1>
          <p className="sub">
            Project Registry record. This page is the citable address for this record — the same URL
            keeps resolving after a correction or a revocation, and says which one happened.
          </p>
        </div>
        <Link href="/explorer/projects">← All projects</Link>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {busy && !entry ? <p className="sub">Loading…</p> : null}

      {entry ? <PublicRecord entry={entry} /> : null}
    </>
  );
}
