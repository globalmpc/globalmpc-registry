"use client";

import { PublicProjectHeader } from "@/components/PublicProjectHeader";
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
    setEntry(null);
    setError(null);
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

      {entry ? <PublicRecord key={entry.entryVersionId} entry={entry} browsableEvidence /> : null}
    </>
  );
}
