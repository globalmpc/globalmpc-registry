import type { LedgerSummary } from "@/lib/evidence-ledger-api";
import { readableStage } from "@/lib/stages";

type Stage = LedgerSummary["stages"][number];

/** Counts describe reviewed claim types, not signed gate approvals or requirement results. */
export function stageCoverage(stage: Stage) {
  const parse = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const reviewed = parse(stage.reviewedItems);
  const required = parse(stage.requiredItems);
  return reviewed !== null && required !== null && reviewed <= required ? { reviewed, required } : null;
}

function StageEvidenceProgress({ stage }: { readonly stage: Stage }) {
  const coverage = stageCoverage(stage);
  return <>
    <span>{coverage ? `${coverage.reviewed} / ${coverage.required} required evidence items reviewed` : "Required-item coverage unavailable"}</span>
    {coverage && coverage.required > 0 ? <progress aria-label={`${readableStage(stage.gateId)} reviewed evidence`} value={coverage.reviewed} max={coverage.required} /> : null}
    {stage.missing?.length ? <span>{new Set(stage.missing).size} missing evidence type(s)</span> : null}
    {stage.status === "watch" ? <span>Warnings need review</span> : stage.status === "not_evaluable" ? <span>Assessment incomplete</span> : null}
  </>;
}

export function ProjectProgress({ summary, published = false }: {
  readonly summary: Pick<LedgerSummary, "evaluatedAt" | "currentStage" | "stages">;
  readonly published?: boolean;
}) {
  // A later passing stage must not conceal an earlier gap. Order is supplied by the evaluator.
  const attention = summary.stages.find((stage) => stage.status !== "ok");
  const current = summary.stages.find((stage) => stage.gateId === summary.currentStage);
  const focus = attention ?? current;
  return <div className="project-progress">
    <strong>{current ? readableStage(current.gateId) : summary.stages.length ? "No stage established" : "Stage not configured"}</strong>
    <span className="meta">Evidence stage{published ? " in this published version" : " at assessment"} · not a signed decision</span>
    {attention ? <span>Needs attention: {readableStage(attention.gateId)}</span> : summary.stages.length ? <span>All assessed stages meet evidence requirements</span> : null}
    {focus ? <StageEvidenceProgress stage={focus} /> : null}
    <span className="meta">Assessed {summary.evaluatedAt}</span>
  </div>;
}
