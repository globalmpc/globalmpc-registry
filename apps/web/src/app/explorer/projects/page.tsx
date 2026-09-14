"use client";

import { PublicRegistryBrowser } from "@/components/PublicRegistryBrowser";

/**
 * Project Registry 공개 목록 — spec 11 §11.2.
 *
 * Explorer가 같은 목록을 첫 화면에 두지만 이 경로가 따로 있는 이유는 공개
 * navigation이 registry별로 갈라져 있기 때문이다(§11.2). "Explorer에서 찾아라"는
 * 안내는 세 registry 중 어느 것을 보고 있는지 말하지 않는다.
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
