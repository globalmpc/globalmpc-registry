"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listProjectItems, type ProjectListItem } from "@/lib/projects-api";
import { useSession } from "@/lib/session";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Project picker behind a global workspace entry — spec 11 §11.2.
 *
 * Data Room, Verification and Readiness & Gates exist per project. The global entry answers
 * "which project?" with the projects this session can open, then goes to that project's screen.
 * The list is the server's visible set; a project missing here is one the session cannot open.
 */
export function ProjectPicker({
  title,
  description,
  links,
}: {
  readonly title: string;
  readonly description: string;
  readonly links: readonly { readonly label: string; readonly path: (projectId: string) => string }[];
}) {
  const { token, loading: sessionLoading } = useSession();
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (sessionLoading || !token) return;
    listProjectItems(token, {})
      .then((page) => {
        setProjects(page.items);
        setError(null);
      })
      .catch(setError);
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
          <h1>{title}</h1>
          <p className="sub">{description}</p>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {projects === null ? (
        error ? null : <p className="sub">Loading…</p>
      ) : projects.length === 0 ? (
        <div className="panel">
          <p className="sub" style={{ margin: 0 }}>
            No project is visible to this account. There is no data here; this is not a permission
            problem.
          </p>
        </div>
      ) : (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="table-scroll">
            <table data-testid="project-picker">
              <thead>
                <tr>
                  <th scope="col">Project key</th>
                  <th scope="col">Name</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td className="mono">{project.projectKey}</td>
                    <td>{project.name}</td>
                    <td className="mono">{project.lifecycleState}</td>
                    <td>
                      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                        {links.map((link) => (
                          <Link
                            key={link.label}
                            href={link.path(project.id)}
                            aria-label={`${link.label} — ${project.projectKey}`}
                          >
                            {link.label}
                          </Link>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
