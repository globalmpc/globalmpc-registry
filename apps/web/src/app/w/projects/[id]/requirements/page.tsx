"use client";

import { use } from "react";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { WorkspaceEvidenceLedger } from "@/components/EvidenceLedger";

export default function RequirementsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { token, session } = useSession();
  const base = `/w/projects/${encodeURIComponent(id)}`;
  const actions = session?.actions ?? [];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requirements</h1>
          <p className="sub">
            Inspect the evidence, gaps and review scope behind this project’s
            assessed stage.
          </p>
        </div>
        {actions.includes("source.upload") ? (
          <Link className="btn-connect" href={`${base}/register`}>
            Add evidence →
          </Link>
        ) : null}
      </div>
      <div className="workflow-links">
        {actions.includes("evidence.read") ? (
          <Link href={`${base}/documents`}>Files and versions</Link>
        ) : null}
        {actions.includes("verification.read") ? (
          <Link href={`${base}/verification`}>Assigned reviews</Link>
        ) : null}
        {actions.includes("readiness.read") ? (
          <Link href={`${base}/readiness`}>
            Readiness and blocking requirements
          </Link>
        ) : null}
      </div>
      {token ? (
        <WorkspaceEvidenceLedger
          key={`${token}:${id}`}
          token={token}
          projectId={id}
          browsable
        />
      ) : null}
    </>
  );
}
