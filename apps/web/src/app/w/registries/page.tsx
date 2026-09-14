"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listRegistryEntries, type RegistryEntrySummary } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Registries — spec 11 §11.2.
 *
 * 게시 상태는 프로젝트를 열어야만 보였다. 그러면 "이 tenant에서 무엇이
 * 게시됐나"에 답하려면 프로젝트를 하나씩 열어야 하고, 그것은 답이 아니다.
 *
 * **게시와 anchor를 한 칸에 합치지 않는다.** 합치면 "게시됐으니 체인에 있다"로
 * 읽힌다. 둘은 다른 사건이고 사이에 batch 생성과 확정이 있다.
 */

const TYPES = ["project", "verification", "asset"] as const;

export default function RegistriesPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [items, setItems] = useState<RegistryEntrySummary[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<"all" | (typeof TYPES)[number]>("all");

  useEffect(() => {
    if (sessionLoading || !token) return;
    let live = true;
    listRegistryEntries(token)
      .then((page) => {
        if (live) setItems(page.items);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [token, sessionLoading]);

  if (!sessionLoading && !session?.authenticated) {
    return <p className="sub">No account is connected.</p>;
  }

  const shown = filter === "all" ? items : items.filter((item) => item.registryType === filter);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Registries</h1>
          <p className="sub">
            Publication state across the three registries without opening a project. Publishing and
            anchoring are separate events and are shown in separate columns.
          </p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel">
        <div className="row" style={{ gap: 6 }} data-testid="registry-filter">
          {(["all", ...TYPES] as const).map((option) => (
            <button
              key={option}
              className={filter === option ? "primary" : undefined}
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        {shown.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Nothing has been recorded in this registry. This is not a permission problem.
          </p>
        ) : (
          <div className="table-scroll">
            <table data-testid="registry-table">
              <thead>
                <tr>
                  <th>Registry</th>
                  <th>Key</th>
                  <th>Version</th>
                  <th>Publication</th>
                  <th>Anchor</th>
                  <th>Published</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr key={item.entryId}>
                    <td className="mono">{item.registryType}</td>
                    <td className="mono">
                      {item.status === "draft" ? (
                        item.publicKey
                      ) : (
                        // 게시된 것만 공개 URL을 갖는다. draft에 링크를 걸면
                        // 404가 정상 동작이 된다.
                        <Link
                          href={`/explorer?registryType=${item.registryType}&publicKey=${encodeURIComponent(item.publicKey)}`}
                        >
                          {item.publicKey}
                        </Link>
                      )}
                    </td>
                    <td className="mono">v{item.latestVersion}</td>
                    <td className="mono">
                      {item.status}
                      {item.revokedAt ? (
                        <div className="meta" style={{ color: "var(--destructive-text)" }}>
                          revoked
                        </div>
                      ) : null}
                    </td>
                    <td className="mono">
                      {item.anchored ? (
                        <span style={{ color: "var(--positive)" }}>in a batch</span>
                      ) : (
                        // 아직 batch에 들어가지 않았다는 것은 실패가 아니다.
                        <span className="meta">not yet</span>
                      )}
                    </td>
                    <td className="mono meta">{item.publishedAt ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
