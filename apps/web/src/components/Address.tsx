"use client";

import { useState } from "react";

/**
 * Wallet address display — always the full address, copyable.
 *
 * A shortened address (`0x4868…`) cannot be compared by eye. Producing another address with the
 * same leading characters is not hard, and an operator linking or deactivating people clicks the wrong row.
 * Show it in full and attach a copy button so transcription errors do not happen.
 */
export function Address({ value, label = "wallet address" }: {
  readonly value: string;
  readonly label?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // Permission denied or insecure context. The full address is on screen, so it can be selected and copied manually.
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1600);
  }

  return (
    <span className="address">
      <span className="mono address-value" data-testid="wallet-address">
        {value}
      </span>
      <button
        type="button"
        className="address-copy"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : "Copy"}
      </button>
    </span>
  );
}
