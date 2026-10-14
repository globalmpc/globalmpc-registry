"use client";

import { ProjectPicker } from "@/components/project/ProjectPicker";

/**
 * Global Readiness & Gates entry — spec 11 §11.2.
 *
 * Two links per project, not one: the gate decision is a separate step from the readiness
 * matrix (§11.3), and a single link would put them back on one screen.
 */
export default function ReadinessIndexPage() {
  return (
    <ProjectPicker
      title="Readiness & Gates"
      description="Readiness is assessed per project and gate. A readiness result is an input to a decision, not the decision."
      links={[
        { label: "Readiness", path: (id) => `/w/projects/${id}/readiness` },
        { label: "Gate decision", path: (id) => `/w/projects/${id}/gates/registry_publication` },
      ]}
    />
  );
}
