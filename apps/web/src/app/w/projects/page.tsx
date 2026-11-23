"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  listProjectItems,
  type ProjectListFilters,
  type ProjectListItem,
} from "@/lib/projects-api";
import { useSession } from "@/lib/session";
import { can } from "@/lib/access";
import { ErrorNotice } from "@/components/ErrorNotice";
import { TruncatedNotice } from "@/components/TruncatedNotice";

import { WorkspaceProjectProgress } from "@/components/WorkspaceProjectProgress";
import { LifecycleBadge } from "@/components/StatusBadge";

/**
 * Project List — spec 11 §11.3.
 *
 * Summarizes projects by evidence stage, lifecycle and owning organization.
 * Filters: assignment, stage, host country, grade, gap, stale, reference status.
 *
 * Filters run on the server, inside the caller's visible projects. Filtering on the screen
 * would only filter the first page, and a filtered list that silently misses rows reads as
 * "there are no others".
 */

const STAGES = [
  "draft",
  "registered",
  "offering_open",
  "offering_closed",
  "active",
  "branch_vote",
  "continuing",
  "divested",
  "closure",
  "retired",
  "suspended",
];

const GRADES = ["rejected", "unverified", "self_reported", "partially_verified", "verified"];

export default function ProjectListPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [filters, setFilters] = useState<ProjectListFilters>({});
  // The server caps the list, most recently updated first, and says when it did.
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (sessionLoading) return;
    if (!token) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    listProjectItems(token, filters)
      .then((data) => {
        if (!live) return;
        setProjects(data.items);
        setTruncated(data.truncated);
        setError(null);
      })
      .catch(error => { if (live) setError(error); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token, sessionLoading, session?.subjectId, filters]);

  if (!sessionLoading && !token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

  function set<K extends keyof ProjectListFilters>(key: K, value: ProjectListFilters[K] | "") {
    setFilters((current) => {
      const next = { ...current };
      if (value === "" || value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  const filtered = Object.keys(filters).length > 0;

  const renderProjectFilters = () => {
    return (
      <form
        className="panel"
        aria-label="Project filters"
        data-testid="project-filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="filter-stage">Lifecycle</label>
            <select
              id="filter-stage"
              value={filters.stage ?? ""}
              onChange={(event) => set("stage", event.target.value)}
            >
              <option value="">Any</option>
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 120 }}>
            <label htmlFor="filter-country">Host country (ISO3)</label>
            <input
              id="filter-country"
              className="mono"
              maxLength={3}
              value={filters.hostCountry ?? ""}
              onChange={(event) => {
                const value = event.target.value.toUpperCase();
                // Only a full code narrows; a partial code would match nothing and look empty.
                set("hostCountry", value.length === 3 ? value : "");
              }}
            />
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="filter-grade">Weakest grade</label>
            <select
              id="filter-grade"
              value={filters.grade ?? ""}
              onChange={(event) => set("grade", event.target.value)}
            >
              <option value="">Any</option>
              {GRADES.map((grade) => (
                <option key={grade} value={grade}>
                  {grade}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="filter-reference">Reference label</label>
            <select
              id="filter-reference"
              value={filters.referenceStatus ?? ""}
              onChange={(event) => set("referenceStatus", event.target.value)}
            >
              <option value="">Any</option>
              <option value="none">None</option>
              <option value="official_reference">Official Reference</option>
              <option value="synthetic_test_project">Synthetic test project</option>
            </select>
          </div>
          <label className="row" style={{ gap: 6, marginBottom: 14 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={filters.assignment === "mine"}
              onChange={(event) => set("assignment", event.target.checked ? "mine" : "")}
            />
            Assigned to me
          </label>
          <label className="row" style={{ gap: 6, marginBottom: 14 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={filters.gap === "true"}
              onChange={(event) => set("gap", event.target.checked ? "true" : "")}
            />
            Has a gap
          </label>
          <label className="row" style={{ gap: 6, marginBottom: 14 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={filters.stale === "true"}
              onChange={(event) => set("stale", event.target.checked ? "true" : "")}
            />
            Stale evidence
          </label>
        </div>
      </form>
    );
  };

  const renderTruncationNotice = () => {
    return truncated && projects ? (
      <TruncatedNotice
        shown={projects.length}
        noun="projects, most recently updated first"
        testId="projects-truncated"
      />
    ) : null;
  };

  const renderProjectList = () => {
    return loading ? (
      <p className="sub">Loading…</p>
    ) : projects && projects.length > 0 ? (
      <table className="workspace-project-list" data-testid="project-list">
        <thead><tr>
          <th scope="col">Project</th>
          <th scope="col">Evidence stage</th>
          <th scope="col">Lifecycle</th>
          <th scope="col">Owner</th>
        </tr></thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <td>
                <strong>{project.name}</strong>
                <Link href={`/w/projects/${project.id}`} className="mono">{project.projectKey}</Link>
              </td>
              <td>
                <span className="project-mobile-label" aria-hidden="true">Evidence stage</span>
                {token && can(session, "readiness.read")
                  ? <WorkspaceProjectProgress key={`${session?.subjectId}:${project.id}`} token={token} projectId={project.id} savedSummary={project.stageProgress} />
                  : "Assessment access required"}
              </td>
              <td><span className="project-mobile-label" aria-hidden="true">Lifecycle</span><LifecycleBadge state={project.lifecycleState} /></td>
              <td><span className="project-mobile-label" aria-hidden="true">Owner</span>{project.ownerOrganizationName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : projects ? (
      <div className="panel">
        <p className="sub" style={{ margin: 0 }}>
          {/* Distinguish Empty from no permission (§11.7). A permission problem would have
                    shown an ErrorNotice above. */}
          {filtered
            ? "No project matches these filters. Other projects may exist; clear the filters to see them."
            : "No projects are available to your account. There is no data here; this is not a permission problem."}
        </p>
      </div>
    ) : null;
  };

  const renderSessionSummary = () => {
    return session?.authenticated ? (
      <p className="meta">
        Roles{" "}
        <span className="mono">
          {session.roleBindings?.map((binding) => binding.role).join(", ") || "none"}
        </span>
      </p>
    ) : null;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="sub">
            Projects you can access appear here.
          </p>
        </div>
        {/* Offered only to a session whose roles can create a project; the server decides. */}
        {can(session, "project.create") ? (
          <Link href="/w/projects/new">
            <button className="primary">New project</button>
          </Link>
        ) : null}
      </div>

      {renderProjectFilters()}

      {error ? <ErrorNotice error={error} /> : null}

      {renderTruncationNotice()}

      {renderProjectList()}

      {renderSessionSummary()}
    </>
  );
}
