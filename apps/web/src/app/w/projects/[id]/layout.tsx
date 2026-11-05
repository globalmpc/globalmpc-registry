"use client";

import { useParams, usePathname } from "next/navigation";
import { ProjectWorkspaceNav } from "@/components/project/ProjectWorkspaceNav";

export default function ProjectLayout({ children }: { readonly children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  // Overview places its navigation below the project title; subpages share the same destinations.
  return <>{pathname !== `/w/projects/${id}` ? <ProjectWorkspaceNav projectId={id} /> : null}{children}</>;
}
