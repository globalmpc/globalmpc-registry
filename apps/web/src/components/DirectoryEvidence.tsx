import { publicEvidenceLedger } from "@mpc/api-contract";
import { PROJECT_STAGES } from "@/lib/stages";

export function directoryReviewedItemCount(value: unknown): number | null {
  const parsed = publicEvidenceLedger.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.items.filter(item => item.status === "reviewed").length;
}

/** Compact summary of the published assessment; no live-state or gate-decision claim. */
export function DirectoryEvidence({ value }: { readonly value: unknown }) {
  const parsed = publicEvidenceLedger.safeParse(value);
  const stage = parsed.success ? PROJECT_STAGES.findIndex(item => item.gateId === parsed.data.currentStage) + 1 : 0;
  const assessed = parsed.success && parsed.data.stages.length > 0;
  return <div className="directory-evidence" title="Evidence progress in the published assessment; not a signed gate decision">
    <span>{stage > 0 ? `Stage ${stage} of ${PROJECT_STAGES.length}` : assessed ? "No stage established" : "Not assessed"}</span>
    <ol className="directory-stage-bar" aria-label="Published evidence stages">
      {PROJECT_STAGES.map((item) => <li key={item.gateId}
        data-status={parsed.success ? parsed.data.stages.find(s => s.gateId === item.gateId)?.status ?? "not_assessed" : "not_assessed"}
        title={item.label}><span className="sr-only">{item.label}: {parsed.success ? parsed.data.stages.find(s => s.gateId === item.gateId)?.status ?? "not assessed" : "not assessed"}</span></li>)}
    </ol>
  </div>;
}
