"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { getPublicRegistryEntry, type PublicProjection } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PublicRecord } from "@/components/PublicRecord";

/**
 * 공유 가능한 공개 프로젝트 URL — spec 11 §11.3.
 *
 * 예전에는 공개 기록을 남에게 보내려면 "Explorer에 가서 이 키를 넣어라"고 말해야
 * 했다. 링크가 곧 기록이어야 인용·감사·이의제기가 같은 것을 가리킨다.
 *
 * **이 화면이 새 데이터를 만들지 않는다.** 공개 projection 밖의 필드는 서버가
 * 반환하지 않으며, 여기서 다른 endpoint를 덧붙여 채우지 않는다.
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
