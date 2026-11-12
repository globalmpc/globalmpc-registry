import type { LedgerSummary } from "@/lib/evidence-ledger-api";

import { readableStage } from "@/lib/stages";
export { readableStage } from "@/lib/stages";
import { ProjectProgress, stageCoverage } from "./ProjectProgress";

/** Only actual assessed gates are displayed: a prototype's position is not stage authority. */
export function StageAssessments({
  summary,
}: {
  readonly summary: LedgerSummary;
}) {
  return (
    <section className="stage-section" aria-label="Stage assessments">
      <div className="section-heading">
        <h3>Stage assessments</h3>
        <span className="meta">
          Evidence readiness · separate from a human decision
        </span>
      </div>
      {summary.stages.length === 0 ? (
        <p className="sub">
          No stage rules have been assessed. A stage cannot be inferred from
          uploaded files.
        </p>
      ) : (
        <>
          <ProjectProgress summary={summary} />
          <div className="stage-assessments" role="list" aria-label="Configured evidence stages">
          {summary.stages.map((stage) => (
            <details
              key={`${stage.gateId}:${stage.ruleSetVersion}`}
              role="listitem"
              className={`stage-assessment ${stage.gateId === summary.currentStage ? "is-current" : ""}`}
            >
              <summary>
                <span className="stage-dot" aria-hidden="true" />
                <strong>{readableStage(stage.gateId)}</strong>
                {stage.gateId === summary.currentStage ? <span className="meta">Evidence stage at assessment</span> : null}
                <span className="meta">{stageCoverage(stage) !== null ? `Reviewed ${stage.reviewedItems} / ${stage.requiredItems} required items` : "Required-item coverage unavailable"}</span>
                <span className={`state-label state-${stage.status}`}>
                  {(
                    {
                      ok: "Requirements met",
                      gap: "Missing requirements",
                      watch: "Watch",
                      not_evaluable: "Cannot evaluate",
                    } as Record<string, string>
                  )[stage.status] ?? stage.status}
                </span>
              </summary>
              <div className="stage-assessment-detail">
                {stage.gateId === summary.currentStage ? (
                  <p className="meta">Evidence stage at this assessment</p>
                ) : null}
                <p className="meta">Rule {stage.ruleSetVersion}</p>
                {stage.missing?.length ? (
                  <>
                    <h4>Missing requirements</h4>
                    <ul>
                      {stage.missing.map((key) => (
                        <li key={key}>
                          {summary.items.find((item) => item.claimType === key)
                            ?.displayName ?? key}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </details>
          ))}
        </div>
        </>
      )}
    </section>
  );
}
