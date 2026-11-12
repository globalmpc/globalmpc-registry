"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StageAssessments } from "./StageAssessments";
import { ErrorNotice } from "./ErrorNotice";
import {
  getEvidenceLedger,
  type LedgerSummary,
  type LedgerCurrent,
} from "@/lib/evidence-ledger-api";

const STATUS_LABELS: Record<string, string> = {
  missing: "Missing evidence",
  unreviewed: "Unreviewed",
  reviewed: "Reviewed",
  needs_re_review: "Needs another review",
  conflicting: "Conflicting",
  rejected: "Rejected",
  not_applicable: "Not applicable",
  ok: "Requirements met",
  gap: "Missing requirements",
  watch: "Watch",
  not_evaluable: "Cannot evaluate",
};
const STAGE_LABELS: Record<string, string> = {
  "stage.exploration": "Exploration",
  "stage.resource_defined": "Resource definition",
  "stage.feasibility": "Feasibility",
  "stage.permitted": "Permitting",
  "stage.production": "Production",
};
const GRADE_LABELS: Record<string, string> = {
  rejected: "Rejected",
  unverified: "Unverified",
  self_reported: "Self reported",
  partially_verified: "Partially verified",
  verified: "Verified",
};
function readableLabel(value: string) {
  const text = value.replace(/^stage\./, "").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function stageLabel(stage: string) {
  return STAGE_LABELS[stage] ?? readableLabel(stage);
}
function gradeLabel(grade: string | null | undefined) {
  return grade ? (GRADE_LABELS[grade] ?? readableLabel(grade)) : "Not graded";
}
const REASON_LABELS: Record<string, string> = {
  UNRESOLVED_CONFLICT: "An unresolved conflict affects this item.",
  EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT:
    "Supporting evidence or its review is no longer current.",
  REJECTED_OR_EXCLUDED_EVIDENCE:
    "Evidence was rejected or excluded by the applicable rule.",
  RECORDED_NOT_APPLICABLE: "A reasoned not-applicable decision was recorded.",
  NO_CATALOG_CLAIM: "No claim is recorded for this definition.",
  CURRENT_SCOPED_REVIEW: "A current signed review covers the linked evidence.",
  CURRENT_SCOPED_REVIEW_REQUIRED:
    "A current signed review of the linked evidence is still needed.",
};
function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}
function reasonsText(reasons: string[]) {
  return reasons.map((reason) => REASON_LABELS[reason] ?? reason).join("; ");
}

export function EvidenceLedger({
  summary,
  title,
  browsable = false,
}: {
  readonly summary: LedgerSummary;
  readonly title: string;
  readonly browsable?: boolean;
}) {
  const ItemContainer = browsable ? "details" : "div";
  const ItemHeading = browsable ? "summary" : "div";
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const visibleItems = summary.items.filter((item) =>
    (!browsable || status === "all" || item.status === status) &&
    (!browsable || `${item.displayName} ${item.claimType}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const reviewed = summary.items.filter(
    (item) => item.status === "reviewed",
  ).length;
  return (
    <section className="panel" data-testid="evidence-ledger">
      <h2>{title}</h2>
      <p className="sub">
        Computed evidence assessment, separate from human confirmations,
        readiness, and permission to proceed.
      </p>
      <dl className={browsable ? "assessment-summary" : "dl"}>
        <dt>Evaluated at</dt>
        <dd>{summary.evaluatedAt}</dd>
        <dt>Evidence stage at assessment</dt>
        <dd>
          {summary.currentStage
            ? stageLabel(summary.currentStage)
            : "No stage established"}
        </dd>
        <dt>Reviewed coverage</dt>
        <dd>
          {reviewed} / {summary.items.length} items
        </dd>
      </dl>
      {browsable ? <StageAssessments summary={summary} /> : null}
      {browsable ? (
        <div className="evidence-browser-controls">
          <label>Search evidence items
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or claim type" />
          </label>
          <label>Evidence status
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All statuses</option>
              {Object.entries(STATUS_LABELS).filter(([value]) => summary.items.some((item) => item.status === value)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <p role="status">Showing {visibleItems.length} of {summary.items.length} items</p>
        </div>
      ) : null}
      {summary.items.length === 0 ? (
        <p>No catalog items assessed.</p>
      ) : (
        <ul className={browsable ? "evidence-browser-list" : undefined}>
          {visibleItems.map((item) => (
            <li key={`${item.claimType}-${item.catalogVersion ?? "legacy"}`}>
              <ItemContainer className={browsable ? "evidence-browser-item" : undefined}>
              <ItemHeading>
              <strong>
                {item.displayName}
                {item.catalogVersion
                  ? ` · catalog v${item.catalogVersion}`
                  : ""}
              </strong>
              {!browsable ? ": " : null}
              <span className={`state-label state-${item.status}`} data-testid={`ledger-status-${item.claimType}`}>
                {statusLabel(item.status)}
              </span>
              </ItemHeading>
              <p className="meta">Evidence grade: {gradeLabel(item.grade)}</p>
              <p className="meta">
                Reviewed item scope:{" "}
                {item.reviewScope
                  ?.map((scope) =>
                    scope === item.claimType
                      ? item.displayName
                      : readableLabel(scope),
                  )
                  .join("; ") || "No current signed scope"}
              </p>
              {item.reviews?.length ? (
                <ul aria-label={`Scoped reviews for ${item.displayName}`}>
                  {item.reviews.map((review) => (
                    <li
                      key={`${review.reviewerHandle}-${review.signedAt}-${review.attestationType}`}
                    >
                      Pseudonymous reviewer{" "}
                      <span className="mono">
                        {review.reviewerHandle.slice(0, 14)}…
                      </span>
                      {" · "}
                      {review.credentialType}
                      {" · "}
                      {review.attestationType}
                      {" · signed "}
                      {review.signedAt}
                      <p className="meta">{review.limitations}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.reasons.length > 0 ? (
                <p>{reasonsText(item.reasons)}</p>
              ) : null}
              {item.limitations.length > 0 ? (
                <p className="meta">
                  Limitations: {item.limitations.join("; ")}
                </p>
              ) : null}
              </ItemContainer>
            </li>
          ))}
        </ul>
      )}
      {browsable && summary.items.length > 0 && visibleItems.length === 0 ? <p>No items match these filters. <button type="button" onClick={() => { setQuery(""); setStatus("all"); }}>Clear filters</button></p> : null}
      {!browsable ? summary.stages.map((stage) => (
        <p key={`${stage.gateId}-${stage.ruleSetVersion}`}>
          <strong>{stageLabel(stage.gateId)}</strong>:{" "}
          {statusLabel(stage.status)} · rule {stage.ruleSetVersion}
          {stage.reviewedItems !== undefined && stage.requiredItems !== undefined
            ? ` · Reviewed ${stage.reviewedItems} / ${stage.requiredItems} required items`
            : " · Required-item coverage unavailable"}
          {stage.missing?.length
            ? ` · Missing: ${stage.missing.join(", ")}`
            : ""}
        </p>
      )) : null}
      <p className="meta">{summary.limitations.join("; ")}</p>
    </section>
  );
}
export function WorkspaceEvidenceLedger({
  token,
  projectId,
  revision = 0,
  browsable = false,
  mayManagePolicies = false,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly revision?: number;
  readonly browsable?: boolean;
  readonly mayManagePolicies?: boolean;
}) {
  const [summary, setSummary] = useState<LedgerSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setSummary(null);
    setError(null);
    void getEvidenceLedger(token, projectId)
      .then((result) => {
        if (live) setSummary(result.snapshot);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [token, projectId, revision]);
  if (error)
    return (
      <section className="panel">
        <h2>Current evidence assessment unavailable</h2>
        <ErrorNotice error={error} />
      </section>
    );
  return summary ? (
    <>
      {summary.stages.length === 0 ? <div className="notice" role="status">
        <div className="title">Stage progression needs configured policies</div>
        <p>No effective stage policy was applied to this assessment. Your workspace operator must propose the stage requirements and an independent authorized reviewer must approve them before this project can establish an evidence stage.</p>
        {mayManagePolicies ? <Link href="/w/registries">Configure policy sets in review registries →</Link> : null}
      </div> : null}
      <EvidenceLedger summary={summary} title="Current evidence assessment" browsable={browsable} />
    </>
  ) : (
    <p role="status">Loading evidence assessment…</p>
  );
}
export function EvidenceLedgerWarnings({
  current,
}: {
  readonly current: LedgerCurrent;
}) {
  return (
    <section className="panel" data-testid="evidence-ledger-current">
      <h2>Current evidence warnings</h2>
      <p className="sub">
        Checked {current.evaluatedAt}. These warnings are separate from the
        approved record and do not change its hash or proof.
      </p>
      {current.warnings.length === 0 ? (
        <p>No current warnings reported for published items.</p>
      ) : (
        <ul>
          {current.warnings.map((warning) => (
            <li
              key={`${warning.claimType}-${warning.catalogVersion ?? "legacy"}`}
            >
              {warning.claimType}
              {warning.catalogVersion
                ? ` · catalog v${warning.catalogVersion}`
                : ""}
              : {statusLabel(warning.status)} — {reasonsText(warning.reasons)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
