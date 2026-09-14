"use client";

import { useEffect, useState } from "react";

/**
 * Public unified search input.
 *
 * Results go to `/explorer/search?q=`. It is a full page navigation so the result URL
 * can be sent to others as-is. The label does not use "Search" — if it shares a name with Explorer
 * list search, the two read as doing the same thing.
 */
export function GlobalSearchForm({ initial = "" }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);

  useEffect(() => setValue(initial), [initial]);

  return (
    <form
      className="panel row"
      style={{ alignItems: "flex-end" }}
      action="/explorer/search"
      method="get"
      data-testid="global-search"
    >
      <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
        <label htmlFor="global-search-q">Find a record</label>
        <input
          id="global-search-q"
          name="q"
          className="mono"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Registry key, transaction hash, Merkle root, or leaf hash"
        />
      </div>
      <button className="primary" type="submit" disabled={!value.trim()} data-testid="global-search-submit">
        Find
      </button>
    </form>
  );
}
