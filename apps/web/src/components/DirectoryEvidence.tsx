import { publicEvidenceLedger } from "@mpc/api-contract";
import { readableStage } from "./StageAssessments";

/** List summaries are approved snapshot data, never an assertion of current health. */
export function DirectoryEvidence({ value }: { readonly value: unknown }) {
  const parsed = publicEvidenceLedger.safeParse(value);
  if (!parsed.success)
    return (
      <div className="directory-evidence">
        <span className="meta">Evidence coverage unavailable</span>
      </div>
    );
  const snapshot = parsed.data;
  const reviewed = snapshot.items.filter(
    (item) => item.status === "reviewed",
  ).length;
  return (
    <div className="directory-evidence">
      <strong>
        {snapshot.currentStage
          ? readableStage(snapshot.currentStage)
          : "No stage established"}
      </strong>
      <span className="meta">
        {reviewed} / {snapshot.items.length} items reviewed in this version
      </span>
      <span className="meta">
        Approved assessment · open for current warnings
      </span>
    </div>
  );
}
