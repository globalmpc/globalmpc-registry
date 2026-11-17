"use client";

import { useState } from "react";
import Link from "next/link";
import type { PublicProjection } from "@/lib/api";

export function PublicProjectHeader({
  entry,
  publicKey,
}: {
  readonly entry: PublicProjection | null;
  readonly publicKey: string;
}) {
  const [message, setMessage] = useState("");
  const name =
    typeof entry?.projectName === "string" ? entry.projectName : publicKey;
  const minerals = Array.isArray(entry?.mineral)
    ? entry.mineral.filter((x) => typeof x === "string").join(", ")
    : typeof entry?.mineral === "string"
      ? entry.mineral
      : null;
  async function copy(citation: boolean) {
    try {
      const url = window.location.href;
      await navigator.clipboard.writeText(
        citation
          ? `${name} · ${publicKey} · published version ${entry?.version ?? "unavailable"} · ${entry?.publishedAt ?? "date unavailable"}\n${url}`
          : url,
      );
      setMessage(citation ? "Citation copied" : "Link copied");
    } catch {
      setMessage(
        "Copy is unavailable. Copy this page’s address from your browser.",
      );
    }
  }
  return (
    <header className="public-project-header">
      <Link href="/" className="meta">
        ← All projects
      </Link>
      <div className="page-head">
        <div>
          <div className="row">
            <h1>{name}</h1>
            {entry ? (
              <span
                className={`state-label ${entry.revokedAt ? "state-rejected" : ""}`}
              >
                {entry.status}
                {entry.revokedAt && entry.status !== "revoked"
                  ? " · revoked"
                  : ""}
              </span>
            ) : null}
          </div>
          <p className="sub">
            {[
              publicKey,
              minerals,
              typeof entry?.hostCountry === "string" ? entry.hostCountry : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {entry ? (
          <div className="row">
            <button type="button" onClick={() => void copy(false)}>
              Share
            </button>
            <button type="button" onClick={() => void copy(true)}>
              Cite
            </button>
            <a href="#record-history" onClick={() => { const history = document.getElementById("record-history"); if (history instanceof HTMLDetailsElement) history.open = true; }}>Version history ↓</a>
          </div>
        ) : null}
      </div>
      {entry ? (
        <p className="meta">
          Published {entry.publishedAt ? new Date(entry.publishedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "date unavailable"} (UTC) · Version{" "}
          {entry.version}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="meta">
          {message}
        </p>
      ) : null}
    </header>
  );
}
