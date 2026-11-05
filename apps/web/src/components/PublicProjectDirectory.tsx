"use client";

import { PublicRegistryBrowser } from "./PublicRegistryBrowser";

export function PublicProjectDirectory() {
  return <PublicRegistryBrowser
    registryType="project"
    cards
    hrefFor={(item) => `/explorer/projects/${encodeURIComponent(item.publicKey)}`}
    searchPlaceholder="Project name, key, country, or mineral"
    emptyMessage="No project record has been published yet. Published projects will appear here without signing in."
  />;
}
