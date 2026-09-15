"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listRegistryEntries, type RegistryEntrySummary } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ReviewRegistryPanel } from "@/components/ReviewRegistryPanel";

/**
 * Registries — spec 11 §11.2.
 *
 * Publication state used to be visible only inside a project. Answering "what has this tenant
 * published" then meant opening projects one by one, which is not an answer.
 *
 * **Publication and anchor stay in separate columns.** Merged, they read as "published, so it is
 * on chain". They are different events, with batch creation and confirmation in between.
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
                        // Only published items have a public URL. Linking a draft
                        // makes a 404 the expected behavior.
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
                        // Not yet in a batch is not a failure.
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

      {/* Credentials, schemas and policy sets — proposed by one person, approved by another. */}
      <ReviewRegistryPanel />
    </>
  );
}
