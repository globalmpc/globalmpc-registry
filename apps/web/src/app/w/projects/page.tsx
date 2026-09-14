"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listProjects, type ProjectSummary } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";
import { LifecycleBadge, ReadinessBadge } from "@/components/StatusBadge";
import type { ReadinessStatus } from "@mpc/domain";

export default function ProjectListPage() {
  const { token, session, loading: sessionLoading } = useSession();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (sessionLoading) return;
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    listProjects(token)
      .then((data) => {
        setProjects(data.items);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [token, sessionLoading]);

  if (!sessionLoading && !token) {
    return (
      <p className="sub">
        No account is connected. <Link href="/">Connect an account →</Link>
      </p>
    );
  }

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

      {error ? <ErrorNotice error={error} /> : null}

      {loading ? (
        <p className="sub">Loading…</p>
      ) : projects && projects.length > 0 ? (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Project key</th>
                  <th>Name</th>
                  <th>Host country</th>
                  <th>Minerals</th>
                  <th>lifecycle</th>
                  <th>Readiness</th>
                  <th>Version</th>
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
                    <td>
                      <LifecycleBadge state={project.lifecycleState} />
                    </td>
                    <td>
                      {project.readinessSummary ? (
                        <ReadinessBadge status={project.readinessSummary as ReadinessStatus} />
                      ) : (
                        // Keep "not yet evaluated" from looking the same as "passed".
                        <span className="meta">Not assessed</span>
                      )}
                    </td>
                    <td className="mono">v{project.version}</td>
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
            No projects are registered in this tenant. There is no data here; this is not a
            permission problem.
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
