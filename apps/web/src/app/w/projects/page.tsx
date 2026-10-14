"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  listProjectItems,
  type ProjectListFilters,
  type ProjectListItem,
} from "@/lib/projects-api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { TruncatedNotice } from "@/components/TruncatedNotice";
import { GradeBadge, LifecycleBadge, ReadinessBadge } from "@/components/StatusBadge";

/**
 * Project List — spec 11 §11.3.
 *
 * Columns: code/name, host country, mineral, reference label, lifecycle, registry state,
 * readiness summary, weakest grade, stale/suspended, owner, updated.
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

const REFERENCE_LABEL: Record<ProjectListItem["referenceStatus"], string> = {
  none: "—",
  official_reference: "Official Reference",
  synthetic_test_project: "Synthetic test",
};

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
    setLoading(true);
    listProjectItems(token, filters)
      .then((data) => {
        setProjects(data.items);
        setTruncated(data.truncated);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [token, sessionLoading, filters]);

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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="sub">
            {/* Tenant isolation is enforced by server RLS, not by the screen. Another tenant's
                projects appear in neither the list nor the detail view. */}
            Only projects in the current tenant are listed. Isolation is decided by the server.
          </p>
        </div>
        <Link href="/w/projects/new">
          <button className="primary">New project</button>
        </Link>
      </div>

      <form
        className="panel"
        aria-label="Project filters"
        data-testid="project-filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 160 }}>
            <label htmlFor="filter-stage">Stage</label>
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

      {error ? <ErrorNotice error={error} /> : null}

      {truncated && projects ? (
        <TruncatedNotice
          shown={projects.length}
          noun="projects, most recently updated first"
          testId="projects-truncated"
        />
      ) : null}

      {loading ? (
        <p className="sub">Loading…</p>
      ) : projects && projects.length > 0 ? (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="table-scroll">
            <table data-testid="project-list">
              <thead>
                <tr>
                  <th scope="col">Project key</th>
                  <th scope="col">Name</th>
                  <th scope="col">Host country</th>
                  <th scope="col">Minerals</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Project Registry</th>
                  <th scope="col">Readiness</th>
                  <th scope="col">Weakest grade</th>
                  <th scope="col">Stale / suspended</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td>
                      <Link href={`/w/projects/${project.id}`} className="mono">
                        {project.projectKey}
                      </Link>
                    </td>
                    <td>{project.name}</td>
                    <td className="mono">{project.hostCountryIso3}</td>
                    <td>{project.minerals.join(", ") || "—"}</td>
                    <td>{REFERENCE_LABEL[project.referenceStatus]}</td>
                    <td>
                      <LifecycleBadge state={project.lifecycleState} />
                    </td>
                    <td className="mono">
                      {project.projectRegistryStatus === "none" ? "No record" : project.projectRegistryStatus}
                    </td>
                    <td>
                      {project.readinessSummary ? (
                        <ReadinessBadge status={project.readinessSummary} />
                      ) : (
                        // Keep "not yet evaluated" from looking the same as "passed".
                        <span className="meta">Not assessed</span>
                      )}
                    </td>
                    <td>
                      {project.weakestGrade ? (
                        <GradeBadge grade={project.weakestGrade} />
                      ) : (
                        <span className="meta">No claims</span>
                      )}
                    </td>
                    <td>
                      {project.lifecycleState === "suspended" ? "Suspended" : null}
                      {project.openStaleSignals > 0 ? (
                        <div>{project.openStaleSignals} stale signal(s)</div>
                      ) : project.lifecycleState === "suspended" ? null : (
                        <span className="meta">—</span>
                      )}
                    </td>
                    <td>{project.ownerOrganizationName}</td>
                    <td className="mono meta">{project.updatedAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : projects ? (
        <div className="panel">
          <p className="sub" style={{ margin: 0 }}>
            {/* Distinguish Empty from no permission (§11.7). A permission problem would have
                shown an ErrorNotice above. */}
            {filtered
              ? "No project matches these filters. Other projects may exist; clear the filters to see them."
              : "No projects are registered in this tenant. There is no data here; this is not a permission problem."}
          </p>
        </div>
      ) : null}

      {session?.authenticated ? (
        <p className="meta">
          Tenant <span className="mono">{session.tenantId?.slice(0, 8)}</span> · roles{" "}
          <span className="mono">
            {session.roleBindings?.map((binding) => binding.role).join(", ") || "none"}
          </span>
        </p>
      ) : null}
    </>
  );
}
