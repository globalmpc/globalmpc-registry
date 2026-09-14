"use client";

import { useEffect, useState } from "react";

/**
 * 공개 통합 검색 입력.
 *
 * 결과는 `/explorer/search?q=`로 간다. 전체 페이지 이동으로 두는 이유는 결과 URL을
 * 그대로 남에게 보낼 수 있어야 해서다. 라벨에 "Search"를 쓰지 않는다 — Explorer
 * 목록 검색과 이름이 겹치면 둘이 같은 일을 한다고 읽힌다.
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
