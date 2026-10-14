"use client";

import { useState, type FormEvent } from "react";
import type {
  ConfirmationInput,
  ConfirmationStatus,
  EvidenceKind,
  EvidenceReference,
} from "@/lib/projects-api";

/**
 * Confirmation status display and input — spec 04 §4.2, 11 §11.5.
 *
 * Four states, each with its own glyph and label, so a status never depends on color (§11.8).
 * `pending` says "not confirmed" in words: a quiet grey dot next to a green tick reads as
 * "almost there", which is exactly the impression §11.5 forbids.
 */

const DISPLAY: Record<ConfirmationStatus, { glyph: string; label: string; token: string }> = {
  confirmed: { glyph: "✓", label: "Confirmed", token: "--positive" },
  pending: { glyph: "◷", label: "Pending — not confirmed", token: "--alert" },
  rejected: { glyph: "✕", label: "Rejected", token: "--destructive-text" },
  not_applicable: { glyph: "–", label: "Not applicable", token: "--muted-foreground" },
};

export function ConfirmationBadge({ status }: { readonly status: ConfirmationStatus }) {
  const display = DISPLAY[status];
  return (
    <span className="badge" style={{ color: `var(${display.token})` }} data-status={status}>
      <span className="glyph" aria-hidden="true">
        {display.glyph}
      </span>
      {display.label}
    </span>
  );
}

export function EvidenceText({ evidence }: { readonly evidence: EvidenceReference | null }) {
  if (!evidence) return <span className="meta">No evidence recorded</span>;
  return (
    <span className="mono meta">
      {evidence.kind} {evidence.id.slice(0, 8)}…
    </span>
  );
}

/**
 * Records one confirmation version.
 *
 * The evidence id field is required when "Confirmed" is chosen, and the server re-checks that
 * the id exists in this project and can carry the status — the form cannot make that promise.
 */
export function ConfirmationForm({
  idPrefix,
  submitLabel,
  onSubmit,
}: {
  readonly idPrefix: string;
  readonly submitLabel: string;
  readonly onSubmit: (input: ConfirmationInput) => Promise<void>;
}) {
  const [status, setStatus] = useState<ConfirmationStatus>("pending");
  const [kind, setKind] = useState<EvidenceKind>("source_receipt");
  const [evidenceId, setEvidenceId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit({
        status,
        evidence: evidenceId.trim() ? { kind, id: evidenceId.trim() } : null,
        asOf: asOf || null,
        reason,
      });
      setReason("");
      setEvidenceId("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 560 }}>
      <div className="field">
        <label htmlFor={`${idPrefix}-status`}>Status</label>
        <select
          id={`${idPrefix}-status`}
          value={status}
          onChange={(event) => setStatus(event.target.value as ConfirmationStatus)}
        >
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed (requires evidence)</option>
          <option value="rejected">Rejected</option>
          <option value="not_applicable">Not applicable</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-kind`}>Evidence kind</label>
        <select
          id={`${idPrefix}-kind`}
          value={kind}
          onChange={(event) => setKind(event.target.value as EvidenceKind)}
        >
          <option value="source_receipt">Source receipt</option>
          <option value="upload">Uploaded document</option>
          <option value="attestation">Attestation</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-evidence`}>Evidence id</label>
        <input
          id={`${idPrefix}-evidence`}
          className="mono"
          value={evidenceId}
          onChange={(event) => setEvidenceId(event.target.value)}
          required={status === "confirmed"}
          placeholder="Id of a receipt, upload or attestation in this project"
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-asof`}>As of</label>
        <input
          id={`${idPrefix}-asof`}
          type="date"
          value={asOf}
          onChange={(event) => setAsOf(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-reason`}>Reason</label>
        <input
          id={`${idPrefix}-reason`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </div>
      <button type="submit" disabled={busy}>
        {busy ? "Recording…" : submitLabel}
      </button>
    </form>
  );
}
