"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { visibleNav } from "@/lib/nav";
import { getProject, type ProjectSummary } from "@/lib/api";
import { WORKSPACE_PROJECT_LINKS } from "@/lib/copy";

/** The route owns project selection. No cached project from another route is shown. */
export function WorkspaceShell({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { token, session } = useSession();
  const projectId = /^\/w\/projects\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  const selectedId = projectId && projectId !== "new" ? projectId : null;
  const identity = `${session?.tenantId ?? ""}:${session?.subjectId ?? ""}`;
  const [context, setContext] = useState<{
    id: string;
    identity: string;
    project: ProjectSummary;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const entries = visibleNav(session ?? {});
  const actions = session?.actions ?? [];
  const project =
    context?.id === selectedId && context.identity === identity
      ? context.project
      : null;
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!selectedId || !token || !actions.includes("project.read")) return;
    let live = true;
    getProject(token, selectedId)
      .then((value) => {
        if (live) setContext({ id: selectedId, identity, project: value });
      })
      .catch(() => {
        if (live) setContext(null);
      });
    return () => {
      live = false;
    };
  }, [selectedId, token, identity, session?.actions]);
  const projectLinks = WORKSPACE_PROJECT_LINKS.filter((entry) =>
    actions.includes(entry.requires),
  );
  function link(href: string, label: string, exact = false, active = false) {
    const current = active || (exact
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`));
    return (
      <Link key={href} href={href} aria-current={current ? "page" : undefined}>
        {label}
      </Link>
    );
  }
  return (
    <div className="workspace-shell">
      <button
        type="button"
        className="workspace-menu-toggle"
        aria-expanded={open}
        aria-controls="workspace-sidebar"
        onClick={() => setOpen(!open)}
      >
        {open ? "Close navigation" : "Workspace navigation"}
      </button>
      <aside
        id="workspace-sidebar"
        className={`workspace-sidebar${open ? " is-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <Link href="/w/projects" className="workspace-project-switch">
          <span className="eyebrow">
            {project?.projectKey ?? "MPC Registry"}
          </span>
          <strong>{project?.name ?? "Select a project"}</strong>
          <span className="meta">Switch project ↗</span>
        </Link>
        <nav aria-label="Workspace">
          {entries
            .filter((entry) =>
              ["/w/work", "/w/projects", "/w/notifications"].includes(
                entry.href,
              ),
            )
            .map((entry) => link(entry.href, entry.label, true))}
        </nav>
        {selectedId && projectLinks.length > 0 ? (
          <nav aria-label="Selected project">
            <p className="eyebrow">Project</p>
            {projectLinks.map((entry) =>
              link(
                `/w/projects/${selectedId}${entry.path ? `/${entry.path}` : ""}`,
                entry.label,
                !entry.path,
                (entry.path === "data-room" && ["documents", "claims"].some(path => pathname.startsWith(`/w/projects/${selectedId}/${path}`))) ||
                  (entry.path === "requirements" && pathname === `/w/projects/${selectedId}/register`),
              ),
            )}
          </nav>
        ) : null}
        <details className="workspace-tools">
          <summary>Administration & tools</summary>
          <nav aria-label="Administration and tools">
            {entries
              .filter(
                (entry) =>
                  !["/w/work", "/w/projects", "/w/notifications", ...(selectedId ? ["/w/data-room", "/w/verification", "/w/readiness"] : [])].includes(
                    entry.href,
                  ),
              )
              .map((entry) => link(entry.href, entry.label, true))}
            {selectedId && actions.includes("registry.read") ? link(`/w/projects/${selectedId}/cre`, "CRE status relay", true) : null}
          </nav>
        </details>
        <nav
          className="workspace-sidebar-bottom"
          aria-label="Workspace support"
        >
          <Link href="/">Public registry ↗</Link>
          {link("/w/help", "Help and support", true)}
          {link("/w/settings", "Account settings", true)}
        </nav>
      </aside>
      <div
        key={`${identity}:${pathname}`}
        className="workspace-content"
        id="workspace-content"
      >
        {children}
      </div>
    </div>
  );
}
