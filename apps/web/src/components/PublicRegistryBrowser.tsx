"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  listPublicRegistryEntries,
  type PublicRegistryListItem,
} from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Public Registry list and search.
 *
 * Three screens (Explorer · Projects · Verification Records) show the same thing. Only
 * the registry type and copy differ, so the list lives in one place — split into three,
 * pagination and boundary display drift slightly in each.
 *
 * **"Load more", not page numbers.** The server returns a keyset cursor and does not
 * count totals. Showing a total page count would require a full count on every request,
 * and that cost keeps growing for public lists.
 */

export interface PublicRegistryBrowserProps {
  readonly registryType: "project" | "verification" | "asset";
  /** Where an item opens. If absent, the list is shown without links. */
  readonly hrefFor?: (item: PublicRegistryListItem) => string;
  readonly searchPlaceholder: string;
  /** Guidance when nothing is published. Worded to be distinct from a permission problem (§11.7). */
  readonly emptyMessage: string;
  /** Extra projection fields to show in the table. If absent, only name and status are shown. */
  readonly columns?: readonly { readonly field: string; readonly label: string }[];
}

const PAGE_SIZE = 20;

/** Projection values are within the allowlist but typed unknown. Narrow before display. */
function text(projection: Record<string, unknown>, field: string): string {
  const value = projection[field];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join(", ");
  return "—";
}

export function PublicRegistryBrowser({
  registryType,
  hrefFor,
  searchPlaceholder,
  emptyMessage,
  columns = [],
}: PublicRegistryBrowserProps) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PublicRegistryListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(
    async (options: { readonly append: boolean; readonly cursor: string | null }) => {
      setBusy(true);
      setError(null);
      try {
        const page = await listPublicRegistryEntries(registryType, {
          q: query || undefined,
          limit: PAGE_SIZE,
          cursor: options.cursor ?? undefined,
        });
        // Append only when continuing. When the query changes, previous results must not remain.
        setItems((previous) => (options.append ? [...previous, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (caught) {
        setError(caught);
        if (!options.append) setItems([]);
      } finally {
        setBusy(false);
      }
    },
    [registryType, query],
  );

  useEffect(() => {
    void load({ append: false, cursor: null });
  }, [load]);

  return (
    <>
      <div className="panel">
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
          }}
        >
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
            <label htmlFor="public-search">Search</label>
            <input
              id="public-search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={searchPlaceholder}
            />
          </div>
          {/*
            The label changes while loading, so selecting by name picks different elements depending on
            timing. Provide a separate anchor for tests.
          */}
          <button
            className="primary"
            type="submit"
            data-testid="public-search-submit"
            disabled={busy}
          >
            {busy ? "Loading…" : "Search"}
          </button>
          {query ? (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                setQuery("");
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
        <p className="meta" style={{ marginBottom: 0 }}>
          Published records only. Drafts are never returned here, and the listing does not say which
          organisation published a record.
        </p>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="panel" data-testid="public-registry-list">
        {items.length === 0 && !busy ? (
          <p className="sub" style={{ margin: 0 }} data-testid="public-registry-empty">
            {query ? `Nothing published matches “${query}”.` : emptyMessage}
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  {columns.map((column) => (
                    <th key={column.field}>{column.label}</th>
                  ))}
                  <th>Status</th>
                  <th>Version</th>
                  <th>Published</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.entryVersionId}>
                    <td className="mono">
                      {hrefFor ? (
                        <Link href={hrefFor(item)}>{item.publicKey}</Link>
                      ) : (
                        item.publicKey
                      )}
                    </td>
                    {columns.map((column) => (
                      <td key={column.field}>{text(item.projection, column.field)}</td>
                    ))}
                    <td className="mono">
                      {/* Keep revocation/supersession next to the status. Not making it look current
                          is what §11.6 requires. */}
                      {item.status}
                      {item.revokedAt ? (
                        <span style={{ color: "var(--destructive-text)" }}> · revoked</span>
                      ) : null}
                    </td>
                    <td className="mono">v{item.version}</td>
                    <td className="mono meta">{item.publishedAt ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cursor ? (
          <button
            style={{ marginTop: 14 }}
            disabled={busy}
            data-testid="public-registry-more"
            onClick={() => void load({ append: true, cursor })}
          >
            {busy ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </>
  );
}
