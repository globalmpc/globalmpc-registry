"use client";

import { useState } from "react";
import type { LedgerItem, LedgerSummary } from "@/lib/evidence-ledger-api";
import { PROJECT_STAGES, readableStage } from "@/lib/stages";
import { gradeLabel, reasonsText, statusLabel } from "./EvidenceLedger";

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function PublishedItem({ item }: { readonly item: LedgerItem }) {
  return <li><details className="evidence-browser-item public-evidence-item">
    <summary><span className={`state-label state-${item.status}`} data-testid={`ledger-status-${item.claimType}`}>{statusLabel(item.status)}</span><strong>{item.displayName}</strong></summary>
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
        <dt>Signed</dt><dd><time dateTime={review.signedAt} title={review.signedAt}>{displayDate(review.signedAt)} (UTC)</time></dd>
        <dt>Stated limitations</dt><dd>{review.limitations}</dd>
      </dl>)}
    </div>
  </details></li>;
}

function StageSelector({ summary, selected, onSelect }: {
  readonly summary: LedgerSummary;
  readonly selected: string;
  readonly onSelect: (gate: string) => void;
}) {
  return <ol className="public-stage-selector" aria-label="Project stages">
    {PROJECT_STAGES.map((stage, index) => {
      const assessment = summary.stages.find(item => item.gateId === stage.gateId);
      return <li key={stage.gateId}><button type="button" aria-pressed={selected === stage.gateId}
        aria-controls="published-stage-results" onClick={() => onSelect(stage.gateId)}>
        <span className="public-stage-name"><span aria-hidden="true" className="public-stage-index">{index + 1}</span><strong>{stage.label}</strong></span>
        <span>{assessment ? statusLabel(assessment.status) : "Not assessed"}</span>
        <span className="meta">{assessment?.reviewedItems !== undefined && assessment.requiredItems !== undefined
          ? `Reviewed ${assessment.reviewedItems} / ${assessment.requiredItems}` : "Coverage unavailable"}</span>
      </button></li>;
    })}
  </ol>;
}

function StageContext({ stage, items }: {
  readonly stage: LedgerSummary["stages"][number] | undefined;
  readonly items: LedgerItem[];
}) {
  const knownLinks = stage?.itemClaimTypes !== undefined;
  return <>
      {stage ? <p className="meta" data-testid="selected-stage-summary">{statusLabel(stage.status)} · Rule {stage.ruleSetVersion} · Reviewed {stage.reviewedItems ?? "?"} / {stage.requiredItems ?? "?"} required items</p> : null}
      {!knownLinks ? <p className="meta">{stage ? "This published version does not include item-to-stage links." : "No assessment was published for this stage."} Showing all published items.</p> : null}
      {stage?.missing?.length ? <p className="meta">Missing requirements: {stage.missing.map(type => items.find(item => item.claimType === type)?.displayName ?? type).join(", ")}</p> : null}
  </>;
}

export function PublicEvidenceLedger({ summary }: { readonly summary: LedgerSummary }) {
  const initialStage = PROJECT_STAGES.find(stage => stage.gateId === summary.currentStage)?.gateId ?? PROJECT_STAGES[0].gateId;
  const [selected, setSelected] = useState<string>(initialStage);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [all, setAll] = useState(false);
  const stage = summary.stages.find(candidate => candidate.gateId === selected);
  const knownLinks = stage?.itemClaimTypes !== undefined;
  const stageItems = !all && knownLinks ? summary.items.filter(item => stage.itemClaimTypes!.includes(item.claimType)) : summary.items;
  const items = stageItems.filter(item => (status === "all" || item.status === status) &&
    `${item.displayName} ${item.claimType}`.toLowerCase().includes(query.trim().toLowerCase()));
  const reviewed = summary.items.filter(item => item.status === "reviewed").length;
  const notApplicable = summary.items.filter(item => item.status === "not_applicable").length;
  const other = summary.items.length - reviewed - notApplicable;
  function selectStage(gate: string) { setSelected(gate); setAll(false); setQuery(""); setStatus("all"); }
  return <section className="public-evidence" data-testid="evidence-ledger">
    <div className="public-evidence-overview">
      <div className="public-evidence-totals"><h2><strong>{summary.items.length}</strong> Published evidence items</h2>
        <p>{reviewed} Reviewed · {notApplicable} Not applicable · {other} Other statuses</p></div>
      <div className="public-evidence-distribution" aria-label={`${reviewed} reviewed, ${notApplicable} not applicable, ${other} other statuses`}>
        <span className="reviewed" style={{flexGrow: reviewed}}/><span className="not-applicable" style={{flexGrow: notApplicable}}/><span className="other" style={{flexGrow: other}}/>
      </div>
      <StageSelector summary={summary} selected={selected} onSelect={selectStage}/>
      <dl className="public-assessment-meta">
        <dt>Evidence stage at assessment</dt><dd>{summary.currentStage ? readableStage(summary.currentStage) : "No stage established"}</dd>
        <dt>Reviewed coverage</dt><dd>{reviewed} / {summary.items.length} items</dd>
        <dt>Evaluated at</dt><dd><time dateTime={summary.evaluatedAt} title={summary.evaluatedAt}>{displayDate(summary.evaluatedAt)} (UTC)</time></dd>
      </dl>
      <p className="meta">Published evidence assessment · not a signed decision or permission to proceed.</p>
    </div>
    <div id="published-stage-results" className="public-stage-results">
      <div className="public-results-heading"><h3>{all ? "All published items" : readableStage(selected)}</h3>
        <button type="button" aria-pressed={all} onClick={() => {setAll(!all);setQuery("");setStatus("all");}}>{all ? "Show selected stage" : "All published items"}</button></div>
      {!all ? <StageContext stage={stage} items={summary.items}/> : null}
      <div className="evidence-browser-controls">
        <label>Search evidence items<input type="search" placeholder="Search by name or claim type" value={query} onChange={e => setQuery(e.target.value)}/></label>
        <label>Evidence status<select value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option>
          {[...new Set(stageItems.map(item => item.status))].map(value => <option value={value} key={value}>{statusLabel(value)}</option>)}
        </select></label>
        <p role="status">Showing {items.length} of {stageItems.length} items</p>
      </div>
      <ul className="evidence-browser-list">{items.map(item => <PublishedItem key={`${selected}:${item.claimType}:${item.catalogVersion ?? "legacy"}`} item={item}/>)}</ul>
      {items.length === 0 ? <p>{stageItems.length === 0 ? "No published items are linked to this stage." : "No items match these filters."}
        {stageItems.length > 0 ? <button type="button" onClick={() => {setQuery("");setStatus("all");}}>Clear filters</button> : null}</p> : null}
    </div>
    <p className="meta">{summary.limitations.join("; ")}</p>
  </section>;
}
