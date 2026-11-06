"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { PROJECT_SECTIONS as SECTIONS, PROJECT_TOOLS as TOOLS } from "@/lib/copy";

export function ProjectWorkspaceNav({ projectId }: { readonly projectId: string }) {
  const base = `/w/projects/${encodeURIComponent(projectId)}`;
  const pathname = usePathname();
  const segment = pathname?.slice(base.length + 1).split("/")[0] ?? "";
  const active = SECTIONS.find(([path, , children]) => path === segment || (children as readonly string[]).includes(segment));
  return (
    <nav aria-label="Project workspace" className="project-navigation">
      <div className="project-navigation-main">
        {SECTIONS.map(([path, title]) => <Link key={path} href={path ? `${base}/${path}` : base} aria-current={active?.[0] === path ? "page" : undefined}>{title}</Link>)}
      </div>
      {!segment ? <details className="project-navigation-tools">
        <summary>More project tools</summary>
        <div className="project-navigation-secondary">{TOOLS.map(([path, title]) => <Link key={path} href={`${base}/${path}`}>{title}</Link>)}</div>
      </details> : <div className="project-navigation-secondary">
        {TOOLS.filter(([, , parent]) => parent === active?.[0]).map(([path, title]) => <Link key={path} href={`${base}/${path}`} aria-current={pathname === `${base}/${path}` ? "page" : undefined}>{title}</Link>)}
      </div>}
    </nav>
  );
}
