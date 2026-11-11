import { publicEvidenceLedger } from "@mpc/api-contract";
import { ProjectProgress } from "./ProjectProgress";

/** List summaries are approved snapshot data, never an assertion of current health. */
export function DirectoryEvidence({ value }: { readonly value: unknown }) {
  const parsed = publicEvidenceLedger.safeParse(value);
  if (!parsed.success)
    return (
      <div className="directory-evidence">
        <span className="meta">Evidence coverage unavailable</span>
      </div>
    );
  return <div className="directory-evidence">
    <ProjectProgress summary={parsed.data} published />
    <span className="meta">Approved assessment · open for current warnings</span>
  </div>;
}
