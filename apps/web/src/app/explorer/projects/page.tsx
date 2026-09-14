"use client";

import { PublicRegistryBrowser } from "@/components/PublicRegistryBrowser";

/**
 * Project Registry public list — spec 11 §11.2.
 *
 * Explorer shows the same list on its first screen, but this route exists separately because public
 * navigation is split by registry (§11.2). "Find it in Explorer"
 * does not say which of the three registries is being viewed.
 */
export default function PublicProjectsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Project Registry</h1>
          <p className="sub">
            Projects with a published registry record. A record here means the minimum project
            fields and a responsible party were recorded — it is not an approval, a licence, or an
            offering.
          </p>
        </div>
      </div>

      <PublicRegistryBrowser
        registryType="project"
        hrefFor={(item) => `/explorer/projects/${encodeURIComponent(item.publicKey)}`}
        searchPlaceholder="Project name, key, country, or mineral"
        emptyMessage="No project record has been published yet. This is not a permission problem."
        columns={[
          { field: "projectName", label: "Name" },
          { field: "hostCountry", label: "Country" },
          { field: "mineral", label: "Minerals" },
        ]}
      />
    </>
  );
}
