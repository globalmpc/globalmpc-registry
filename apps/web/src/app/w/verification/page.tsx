"use client";

import { ProjectPicker } from "@/components/project/ProjectPicker";

/** Global Verification entry — spec 11 §11.2. Review cases are opened per project. */
export default function VerificationIndexPage() {
  return (
    <ProjectPicker
      title="Verification"
      description="Review cases belong to a project. Choose the project whose verification workbench you want to open."
      links={[{ label: "Open verification", path: (id) => `/w/projects/${id}/verification` }]}
    />
  );
}
