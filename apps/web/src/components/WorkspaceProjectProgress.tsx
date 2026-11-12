"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ProjectStageProgress } from "@mpc/api-contract";
import { type LedgerSummary } from "@/lib/evidence-ledger-api";
import { ProgressRateLimited, projectProgressRequests } from "@/lib/project-progress-requests";
import { ProjectProgress } from "./ProjectProgress";

/** Parent keys by tenant/subject; project/token changes also discard in-flight state. */
export function WorkspaceProjectProgress(props: {
  readonly token: string;
  readonly projectId: string;
  readonly savedSummary?: ProjectStageProgress | null;
}) {
  return <ProgressRow key={JSON.stringify([props.token, props.projectId])} {...props} />;
}

function ProgressRow({ token, projectId, savedSummary }: Parameters<typeof WorkspaceProjectProgress>[0]) {
  const [summary, setSummary] = useState<LedgerSummary | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed" | "limited">("idle");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!attempt) return;
    let live = true;
    const controller = new AbortController();
    projectProgressRequests.load(token, projectId, controller.signal).then(result => {
      if (live) { setSummary(result.snapshot); setState("idle"); }
    }).catch(error => {
      if (live) setState(error instanceof ProgressRateLimited ? "limited" : "failed");
    });
    return () => { live = false; controller.abort(); };
  }, [token, projectId, attempt]);
  const displayed = summary ?? savedSummary;
  const retry = state === "limited" || state === "failed";
  return <div>
    {displayed ? <>
      <span className="meta">{summary ? "Last requested assessment · may be outdated" : "Saved assessment · may be outdated"}</span>
      <ProjectProgress summary={displayed} />
    </> : <span className="meta">No saved assessment available</span>}
    {state === "loading" ? <span role="status">Loading progress…</span> : null}
    {state === "limited" ? <span role="status">Progress loading paused. Wait one minute before retrying.</span> : null}
    {state === "failed" ? <span role="status">Progress unavailable</span> : null}
    <button type="button" disabled={state === "loading"} onClick={() => {
      setState("loading");
      setAttempt(value => value + 1);
    }}>{retry ? "Retry progress" : displayed ? "Refresh progress" : "Load progress"}</button>{" "}
    <Link href={`/w/projects/${encodeURIComponent(projectId)}/requirements`}>Inspect requirements →</Link>
  </div>;
}
