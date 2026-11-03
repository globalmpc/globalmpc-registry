"use client";

import { useState } from "react";
import { AUTH_COPY } from "@/lib/copy";

const C = AUTH_COPY.recoveryCodes;

/**
 * Recovery codes, shown once.
 *
 * The server returns them only in the answer that created them, so the screen holds them until the
 * person says they kept them; it never stores them anywhere (no storage, no URL). The download is
 * a file made in this browser — nothing is sent anywhere.
 */
export function RecoveryCodes({
  codes,
  onDone,
}: {
  readonly codes: readonly string[];
  readonly onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  function download() {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = C.fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="panel" data-testid="recovery-codes">
      <h2>{C.heading}</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        {C.lead}
      </p>
      <ol className="mono" data-testid="recovery-code-list">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="row">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? C.copied : C.copy}
        </button>
        <button type="button" onClick={download}>
          {C.download}
        </button>
      </div>
      <label className="row" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        {C.saved}
      </label>
      <button className="primary" type="button" disabled={!saved} onClick={onDone} style={{ marginTop: 12 }}>
        {C.continue}
      </button>
    </div>
  );
}
