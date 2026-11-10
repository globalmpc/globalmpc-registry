import { EvidenceLedger } from "@/components/EvidenceLedger";
import type { LedgerSummary } from "@/lib/evidence-ledger-api";

function display(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.filter((entry) => typeof entry === "string").join(" · ");
  return "Not supplied";
}

/** A draft is never sent to a public endpoint or queried for an integrity proof. */
export function DisclosurePreview({
  projection,
}: {
  readonly projection: Record<string, unknown>;
}) {
  return (
    <section
      className="disclosure-preview"
      aria-label="Public disclosure preview"
    >
      <div className="notice">
        <strong>Draft preview · not published</strong>
        <p>
          No public record or integrity proof is created by opening this
          preview.
        </p>
      </div>
      <header className="public-project-header">
        <div className="row">
          <h2>{display(projection.projectName)}</h2>
          <span className="state-label">{display(projection.status)}</span>
        </div>
        <p className="sub">
          {display(projection.projectKey)} · {display(projection.mineral)} ·{" "}
          {display(projection.hostCountry)}
        </p>
        <p className="meta">
          Source as of {display(projection.asOf)} · Project version{" "}
          {display(projection.version)}
        </p>
      </header>
      <section>
        <h3>Limits of this review</h3>
        <p>{display(projection.limitations)}</p>
        <p className="meta">Legal effect: {display(projection.legalEffect)}</p>
      </section>
      {projection.evidenceLedger ? (
        <EvidenceLedger
          summary={projection.evidenceLedger as LedgerSummary}
          title="Evidence assessment in this draft"
          browsable
        />
      ) : null}
    </section>
  );
}
