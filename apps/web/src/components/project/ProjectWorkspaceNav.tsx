import Link from "next/link";
import { REQUIRED_BOUNDARY_COPY } from "@mpc/ui";

const TASKS = [
  ["data-room", "Documents & evidence", "Upload files, connect sources and record claims."],
  ["verification", "Review evidence", "Inspect claims and signed reviewer findings."],
  ["publication", "Prepare publication", "Prepare a record for independent disclosure approval."],
] as const;
const TOOLS = [
  ["documents", "Document status"],
  ["impacts", "Documents to recheck"],
  ["readiness", "Readiness"],
  ["cre", "CRE"],
  ["gates/registry_publication", "Gate decision"],
] as const;

export function ProjectWorkspaceNav({ projectId }: { readonly projectId: string }) {
  const base = `/w/projects/${encodeURIComponent(projectId)}`;
  return (
    <nav aria-label="Project workspace" className="panel">
      <h2>Work on this project</h2>
      <div className="project-task-grid">
        {TASKS.map(([path, title, description]) => (
          <Link className="project-task-link" key={path} href={`${base}/${path}`}>
            <strong>{title} →</strong>
            <span>{description}</span>
          </Link>
        ))}
      </div>
      <div className="project-tool-links">
        {TOOLS.map(([path, title]) => <Link key={path} href={`${base}/${path}`}>{title}</Link>)}
      </div>
      <p className="meta">{REQUIRED_BOUNDARY_COPY.verification}</p>
    </nav>
  );
}
