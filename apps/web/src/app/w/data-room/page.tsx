"use client";

import { ProjectPicker } from "@/components/project/ProjectPicker";

/** Global Data Room entry — spec 11 §11.2. A Data Room belongs to one project. */
export default function DataRoomIndexPage() {
  return (
    <ProjectPicker
      title="Data Room"
      description="Each project has its own Data Room. Choose the project whose sources and claims you want to open."
      links={[{ label: "Open Data Room", path: (id) => `/w/projects/${id}/data-room` }]}
    />
  );
}
