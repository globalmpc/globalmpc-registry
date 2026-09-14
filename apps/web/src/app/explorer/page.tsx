"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getPublicRegistryEntry, type PublicProjection } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PublicRecord } from "@/components/PublicRecord";
import { PublicRegistryBrowser } from "@/components/PublicRegistryBrowser";
import { GlobalSearchForm } from "@/components/GlobalSearchForm";

/**
 * Public Explorer — spec 11 §11.3, OD-02.
 *
 * **이 화면은 목록이 먼저다.** 예전에는 `publicKey`를 이미 알아야 하는 검색 폼
 * 하나였고, 그러면 무엇이 게시돼 있는지 아는 사람만 쓸 수 있다. 공개
 * Registry에서 그것은 공개가 아니다.
 *
 * 키를 아는 경우를 없애지는 않는다 — 게시 화면과 공유 링크가 그 경로로 온다.
 * 그래서 직접 조회를 아래에 남기고 `?registryType=&publicKey=`도 계속 받는다.
 */
export default function ExplorerPage() {
  const [registryType, setRegistryType] = useState("project");
  const [publicKey, setPublicKey] = useState("");
  const [entry, setEntry] = useState<PublicProjection | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // 게시 화면에서 넘어온 링크가 바로 조회되게 한다. 공개 기록의 URL은 남에게
  // 보낼 수 있어야 한다.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const key = query.get("publicKey");
    if (!key) return;
    const type = query.get("registryType") ?? "project";
    setRegistryType(type);
    setPublicKey(key);
    void lookup(type, key);
    // 최초 1회만 — 이후에는 사용자가 폼으로 조회한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function lookup(type: string, key: string) {
    setBusy(true);
    setError(null);
    try {
      setEntry(await getPublicRegistryEntry(type, key.trim()));
    } catch (caught) {
      setError(caught);
      setEntry(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Public Explorer</h1>
          <p className="sub">
            Published records across the three registries. No account is needed, and corrections and
            revocations are shown alongside rather than replacing what they correct.
          </p>
        </div>
        <Link href="/connect" className="btn-connect">
          Connect account →
        </Link>
      </div>

      <GlobalSearchForm />

      <PublicRegistryBrowser
        registryType="project"
        hrefFor={(item) => `/explorer/projects/${encodeURIComponent(item.publicKey)}`}
        searchPlaceholder="Project name, key, country, or mineral"
        emptyMessage="No project record has been published yet. This is not a permission problem."
        columns={[
          { field: "projectName", label: "Name" },
          { field: "hostCountry", label: "Country" },
          { field: "mineral", label: "Minerals" },
        ]}
      />

      <div className="panel">
        <h2>Look up a key directly</h2>
        <p className="sub" style={{ marginTop: 0 }}>
          If you were given a registry key — from a publication receipt or a shared link — you can
          open it here without searching.
        </p>
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(event) => {
            event.preventDefault();
            void lookup(registryType, publicKey);
          }}
        >
          <div className="field" style={{ marginBottom: 0, width: 160 }}>
            <label htmlFor="registryType">Registry</label>
            <select
              id="registryType"
              value={registryType}
              onChange={(event) => setRegistryType(event.target.value)}
            >
              <option value="project">project</option>
              <option value="verification">verification</option>
              <option value="asset">asset</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 220 }}>
            <label htmlFor="publicKey">Public key</label>
            <input
              id="publicKey"
              className="mono"
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
              placeholder="SYNTH-PROJECT-001"
            />
          </div>
          {/* 위의 목록 검색과 이름이 겹치지 않게 한다 — 하는 일도 다르다. */}
          <button className="primary" type="submit" disabled={busy || !publicKey}>
            {busy ? "Looking up…" : "Look up"}
          </button>
        </form>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {entry ? <PublicRecord entry={entry} /> : null}
    </>
  );
}
