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
 * **This screen is list-first.** It used to be a single search form that required already knowing
 * the `publicKey`, usable only by people who knew what was published. In a public
 * Registry, that is not public.
 *
 * The known-key case stays — the publication screen and share links arrive through it.
 * So direct lookup remains below, and `?registryType=&publicKey=` is still accepted.
 */
export default function ExplorerPage() {
  const [registryType, setRegistryType] = useState("project");
  const [publicKey, setPublicKey] = useState("");
  const [entry, setEntry] = useState<PublicProjection | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Links from the publication screen look up immediately. A public record URL must be
  // shareable.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const key = query.get("publicKey");
    if (!key) return;
    const type = query.get("registryType") ?? "project";
    setRegistryType(type);
    setPublicKey(key);
    void lookup(type, key);
    // First time only — afterwards the user looks up via the form.
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
          {/* Keep the name distinct from list search above — they do different things. */}
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
