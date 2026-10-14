"use client";

import { useState } from "react";
import { recordProjectFact, type ProjectFact } from "@/lib/projects-api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ConfirmationBadge, ConfirmationForm, EvidenceText } from "./Confirmation";

/**
 * Confirmed/Pending Matrix — spec 11 §11.5.
 *
 * Every row is shown, recorded or not. A row nobody recorded says so; leaving it out would read
 * as "nothing to confirm". The Reference label is never consulted here — a row is confirmed
 * only by its own recorded evidence (04 invariant 10).
 */

const LABELS: Record<string, string> = {
  relationship: "Project relationship",
  consent: "Consent and data access",
  rights: "Rights",
  issuer: "Issuer",
  spv: "SPV",
  legal_structure: "Legal structure",
  source_data: "Source data",
};

export function FactMatrix({
  token,
  projectId,
  facts,
  canRecord,
  onChanged,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly facts: readonly ProjectFact[];
  readonly canRecord: boolean;
  readonly onChanged: () => void;
}) {
  const [factKey, setFactKey] = useState(facts[0]?.factKey ?? "relationship");
  const [error, setError] = useState<unknown>(null);
  const selected = facts.find((fact) => fact.factKey === factKey);

  return (
    <div className="panel" data-testid="fact-matrix">
      <h2>Confirmed/Pending Matrix</h2>
      <p className="sub" style={{ marginTop: 0 }}>
        Each row is confirmed only by evidence recorded for that row. A Reference label, a
        published record or an anchored proof does not confirm any row.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Status</th>
              <th scope="col">Evidence</th>
              <th scope="col">As of</th>
              <th scope="col">Version</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.factKey} data-fact={fact.factKey}>
                <th scope="row">{LABELS[fact.factKey] ?? fact.factKey}</th>
                <td>
                  <ConfirmationBadge status={fact.status} />
                  {fact.recorded ? null : <div className="meta">Nobody has recorded this yet</div>}
                </td>
                <td>
                  <EvidenceText evidence={fact.evidence} />
                </td>
                <td className="mono">{fact.asOf ?? "—"}</td>
                <td className="mono">{fact.recorded ? `v${fact.version}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canRecord ? (
        <details style={{ marginTop: 14 }}>
          <summary>Record a matrix row</summary>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="field" style={{ maxWidth: 560, marginTop: 12 }}>
            <label htmlFor="fact-key">Item</label>
            <select id="fact-key" value={factKey} onChange={(event) => setFactKey(event.target.value)}>
              {facts.map((fact) => (
                <option key={fact.factKey} value={fact.factKey}>
                  {LABELS[fact.factKey] ?? fact.factKey}
                </option>
              ))}
            </select>
          </div>
          <ConfirmationForm
            idPrefix="fact"
            submitLabel="Record version"
            onSubmit={async (input) => {
              try {
                await recordProjectFact(token, projectId, factKey, selected?.version ?? 0, input);
                setError(null);
                onChanged();
              } catch (caught) {
                setError(caught);
              }
            }}
          />
        </details>
      ) : null}

      {facts.some((fact) => fact.history.length > 0) ? (
        <details style={{ marginTop: 14 }}>
          <summary>Version history</summary>
          <ul>
            {facts.flatMap((fact) =>
              fact.history.map((version) => (
                <li key={`${fact.factKey}-${version.version}`} className="meta">
                  <span className="mono">
                    {fact.factKey} v{version.version}
                  </span>{" "}
                  · {version.status} · {version.reason} ·{" "}
                  <span className="mono">{version.recordedAt}</span>
                </li>
              )),
            )}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
