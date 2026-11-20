"use client";

import { publicDate } from "@/lib/public-date";
import { useState } from "react";
import type { LedgerItem, LedgerSummary } from "@/lib/evidence-ledger-api";
import { PROJECT_STAGES, readableStage } from "@/lib/stages";
import { gradeLabel, reasonsText, statusLabel } from "./EvidenceLedger";

function itemTitle(item: LedgerItem): string {
  const original = /^SYNTHETIC DEMO (public|stage-[1-5]) licence$/.exec(item.displayName);
  return original && item.claimType === `synthetic_dev_demo_${original[1]!.replace("-", "_")}_licence`
    ? "Exploration licence" : item.displayName;
}

function PublishedItem({ item }: { readonly item: LedgerItem }) {
  const latestReview = item.reviews?.map(review => review.signedAt)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return <li><details className="evidence-browser-item public-evidence-item">
    <summary><strong title={item.displayName}>{itemTitle(item)}</strong><span className={`state-label state-${item.status}`} data-testid={`ledger-status-${item.claimType}`}>{statusLabel(item.status)}</span>
      {latestReview ? <time className="meta" dateTime={latestReview} title={`Latest signed review: ${latestReview}`}>{publicDate(latestReview)}</time> : null}
    </summary>
    <div className="public-item-detail">
      <dl className="dl">
        <dt>Evidence grade</dt><dd>{gradeLabel(item.grade)}</dd>
        <dt>Reviewed item scope</dt><dd>{item.reviewScope?.join(", ") || "No current signed scope"}</dd>
        <dt>Catalog version</dt><dd>{item.catalogVersion ?? "Not recorded"}</dd>
      </dl>
      {item.reasons.length > 0 ? <p>{reasonsText(item.reasons)}</p> : null}
      {item.limitations.length > 0 ? <p>Limitations: {item.limitations.join("; ")}</p> : null}
      {item.reviews?.map(review => <dl className="dl public-review-detail" key={`${review.reviewerHandle}-${review.attestationType}-${review.signedAt}`}>
        <dt>Pseudonymous reviewer</dt><dd className="mono">{review.reviewerHandle.slice(0, 14)}…</dd>
        <dt>Credential type</dt><dd>{review.credentialType}</dd>
        <dt>Review type</dt><dd>{review.attestationType}</dd>
        <dt>Signed</dt><dd><time dateTime={review.signedAt} title={review.signedAt}>{publicDate(review.signedAt)}</time></dd>
        <dt>Stated limitations</dt><dd>{review.limitations}</dd>
      </dl>)}
    </div>
  </details></li>;
}

function StageSelector({ summary, selected, onSelect }: {
  readonly summary: LedgerSummary;
  readonly selected: string | null;
  readonly onSelect: (gate: string) => void;
}) {
  return <ol className="public-stage-selector" aria-label="Project stages">
    {PROJECT_STAGES.map((stage, index) => {
      const assessment = summary.stages.find(item => item.gateId === stage.gateId);
      return <li key={stage.gateId} data-status={assessment?.status ?? "not_assessed"}><button type="button" aria-pressed={selected === stage.gateId}
        aria-controls="published-stage-results" onClick={() => onSelect(stage.gateId)}>
        <span className="public-stage-name"><span aria-hidden="true" className="public-stage-index">{index + 1}</span><strong>{stage.label}</strong></span>
        <span>{assessment ? statusLabel(assessment.status) : "Not assessed"}</span>

      </button></li>;
    })}
  </ol>;
}

function StageContext({ stage, items }: {
  readonly stage: LedgerSummary["stages"][number] | undefined;
  readonly items: LedgerItem[];
}) {
  return <>
      {stage ? <p className="meta" data-testid="selected-stage-summary">{statusLabel(stage.status)} · Rule {stage.ruleSetVersion} · Reviewed {stage.reviewedItems ?? "?"} / {stage.requiredItems ?? "?"} required items</p> : null}

      {stage?.missing?.length ? <p className="meta">Missing requirements: {stage.missing.map(type => { const item = items.find(candidate => candidate.claimType === type); return item ? itemTitle(item) : type; }).join(", ")}</p> : null}
  </>;
}

export function PublicEvidenceLedger({ summary }: { readonly summary: LedgerSummary }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const all = selected === null;
  const stage = summary.stages.find(candidate => candidate.gateId === selected);
  const knownLinks = stage?.itemClaimTypes !== undefined;
  const stageItems = !all && knownLinks ? summary.items.filter(item => stage.itemClaimTypes!.includes(item.claimType)) : summary.items;
  const items = stageItems.filter(item => (status === "all" || item.status === status) &&
    `${itemTitle(item)} ${item.displayName} ${item.claimType}`.toLowerCase().includes(query.trim().toLowerCase()));
  const reviewed = summary.items.filter(item => item.status === "reviewed").length;
  function selectStage(gate: string | null) { setSelected(gate); setQuery(""); setStatus("all"); }
  return <section className="public-evidence" data-testid="evidence-ledger">
    <div className="public-evidence-overview">
      <h2 className="public-review-title">Document review items <span className="meta">{summary.items.length} items · {reviewed} reviewed</span></h2>
      <StageSelector summary={summary} selected={selected} onSelect={selectStage}/>
    </div>
    <div id="published-stage-results" className="public-stage-results">
      <div className="public-results-heading"><h3>{all ? "All published items" : readableStage(selected)}</h3>
        {selected !== null ? <button type="button" onClick={() => selectStage(null)}>All published items</button> : null}</div>
      {!all && !knownLinks ? <p className="meta">{stage ? "This published version does not include item-to-stage links." : "No assessment was published for this stage."} Showing all published items.</p> : null}
      <div className="evidence-browser-controls">
        <label>Search evidence items<input type="search" placeholder="Search by name or claim type" value={query} onChange={e => setQuery(e.target.value)}/></label>
        <label>Evidence status<select value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option>
          {[...new Set(stageItems.map(item => item.status))].map(value => <option value={value} key={value}>{statusLabel(value)}</option>)}
        </select></label>
        <p role="status">Showing {items.length} of {stageItems.length} items</p>
      </div>
      <ul className="evidence-browser-list">{items.map(item => <PublishedItem key={`${selected}:${item.claimType}:${item.catalogVersion ?? "legacy"}`} item={item}/>)}</ul>
      {items.length === 0 ? <p>{stageItems.length === 0 ? (all ? "No review items have been published." : "No published items are linked to this stage.") : "No items match these filters."}
        {stageItems.length > 0 ? <button type="button" onClick={() => {setQuery("");setStatus("all");}}>Clear filters</button> : null}</p> : null}
    </div>
    <details className="public-record-disclosure" data-testid="assessment-details"><summary>Assessment details and limitations</summary>
      <dl className="public-assessment-meta">
        <dt>Evidence stage at assessment</dt><dd>{summary.currentStage ? readableStage(summary.currentStage) : "No stage established"}</dd>
        <dt>Reviewed coverage</dt><dd>{reviewed} / {summary.items.length} items</dd>
        <dt>Evaluated at</dt><dd><time dateTime={summary.evaluatedAt} title={summary.evaluatedAt}>{publicDate(summary.evaluatedAt)}</time></dd>
      </dl>
      <p className="meta">Published evidence assessment · not a signed decision or permission to proceed.</p>
      {!all ? <StageContext stage={stage} items={summary.items}/> : null}
      <p className="meta">{summary.limitations.join("; ")}</p>
    </details>
  </section>;
}
