"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  listPublicRegistryEntries,
  type PublicRegistryListItem,
} from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * 공개 Registry 목록·검색.
 *
 * 세 화면(Explorer · Projects · Verification Records)이 같은 것을 본다. 다른
 * 것은 registry type과 문구뿐이므로 목록 자체는 한 곳에 둔다 — 셋으로 나누면
 * 페이지네이션과 경계 표시가 셋 다 조금씩 달라진다.
 *
 * **"더 보기"이지 페이지 번호가 아니다.** 서버가 keyset cursor를 주고 총계를
 * 세지 않는다. 총 페이지 수를 화면에 적으려면 매 요청마다 전체를 세야 하고,
 * 공개 목록은 그 비용이 계속 커진다.
 */

export interface PublicRegistryBrowserProps {
  readonly registryType: "project" | "verification" | "asset";
  /** 항목을 여는 곳. 없으면 링크 없이 목록만 보인다. */
  readonly hrefFor?: (item: PublicRegistryListItem) => string;
  readonly searchPlaceholder: string;
  /** 아무것도 게시되지 않았을 때의 안내. 권한 문제와 구분되게 적는다(§11.7). */
  readonly emptyMessage: string;
  /** 표에 추가로 낼 projection 필드. 없으면 이름과 상태만 낸다. */
  readonly columns?: readonly { readonly field: string; readonly label: string }[];
}

const PAGE_SIZE = 20;

/** projection 값은 allowlist 안이지만 타입은 unknown이다. 표시 전에 좁힌다. */
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
        // 이어 받을 때만 붙인다. 검색어가 바뀌면 이전 결과가 남아 있으면 안 된다.
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
            라벨이 로딩 중에 바뀌므로 이름으로 집으면 타이밍에 따라 다른 것을
            집는다. 테스트가 붙잡을 자리를 따로 둔다.
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
                      {/* 철회·대체를 상태 옆에 그대로 둔다. 최신처럼 보이게
                          하지 않는 것이 §11.6이다. */}
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
