import type { RouteDefinition } from "./routes.js";

/**
 * The five primary layers — D-56, REQ-DAPP-002.
 *
 * REQ-DAPP-002 asks that each function map to **exactly one** primary layer. The mapping is kept
 * as data next to the route contract so that a new route cannot land without a layer: the
 * contract test fails when a route matches no rule, or more than one.
 */
export const PRIMARY_LAYERS = [
  "real_world",
  "verification",
  "data_oracle",
  "asset_infrastructure",
  "application",
] as const;

export type PrimaryLayer = (typeof PRIMARY_LAYERS)[number];

/** Display names as D-56 writes them. */
export const PRIMARY_LAYER_LABELS: Readonly<Record<PrimaryLayer, string>> = {
  real_world: "Real-World",
  verification: "Verification",
  data_oracle: "Data & Oracle",
  asset_infrastructure: "Asset Infrastructure",
  application: "Application",
};

/**
 * Route → layer rules.
 *
 * A pattern ending in `/**` matches the path and everything below it; any other pattern matches
 * that path only. Rules must not overlap — the test checks every route matches exactly one — so
 * a broad prefix and a narrower exception cannot both claim a route and leave the answer to rule
 * order.
 *
 * The grouping follows what each function is about:
 * - **Real-World** — the project, its parties, and the documents that describe the asset.
 * - **Verification** — review cases, attestations, disputes, reviewer credentials and schemas.
 * - **Data & Oracle** — authorities, source connections and receipts, normalized claims,
 *   staleness, jurisdiction profiles, and the readiness evaluation that reads them.
 * - **Asset Infrastructure** — Registry versions, anchoring, gate decisions, the asset lifecycle,
 *   the offering gate, disclosure restrictions on those actions, and governance.
 * - **Application** — sign-in, administration, the audit trail and exports, work queues,
 *   notifications, and the public explorer.
 */
export const ROUTE_LAYER_RULES: readonly { readonly pattern: string; readonly layer: PrimaryLayer }[] = [
  // Real-World
  { pattern: "/api/v1/projects", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}", layer: "real_world" },
  { pattern: "/api/v1/organizations", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/uploads/**", layer: "real_world" },
  { pattern: "/api/v1/uploads/**", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/document-graph", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/document-links", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/document-impacts/**", layer: "real_world" },
  { pattern: "/api/v1/document-links/**", layer: "real_world" },
  { pattern: "/api/v1/document-link-rules/**", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/overview", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/facts/**", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/parties/**", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/registration-requests", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/stakeholder-events", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/document-requirements", layer: "real_world" },
  { pattern: "/api/v1/document-requirements/**", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/document-status", layer: "real_world" },
  { pattern: "/api/v1/projects/{projectId}/documents", layer: "real_world" },

  // Verification
  { pattern: "/api/v1/projects/{projectId}/verification-cases", layer: "verification" },
  { pattern: "/api/v1/projects/{projectId}/review-assignment-options", layer: "verification" },
  { pattern: "/api/v1/verification-cases/**", layer: "verification" },
  { pattern: "/api/v1/attestations/**", layer: "verification" },
  { pattern: "/api/v1/disputes/**", layer: "verification" },
  { pattern: "/api/v1/review-registry/credentials/**", layer: "verification" },
  { pattern: "/api/v1/review-registry/attestation-schemas/**", layer: "verification" },
  { pattern: "/api/v1/assignments/**", layer: "verification" },
  { pattern: "/api/v1/credentials/**", layer: "verification" },

  // Data & Oracle
  { pattern: "/api/v1/authorities/**", layer: "data_oracle" },
  { pattern: "/api/v1/source-connections/**", layer: "data_oracle" },
  { pattern: "/api/v1/source-receipts/**", layer: "data_oracle" },
  { pattern: "/api/v1/projects/{projectId}/source-receipts", layer: "data_oracle" },
  { pattern: "/api/v1/projects/{projectId}/claims", layer: "data_oracle" },
  { pattern: "/api/v1/claims/**", layer: "data_oracle" },
  { pattern: "/api/v1/projects/{projectId}/evidence-ledger", layer: "data_oracle" },
  { pattern: "/api/v1/projects/{projectId}/cre-reports", layer: "data_oracle" },
  { pattern: "/api/v1/claim-types/**", layer: "data_oracle" },
  { pattern: "/api/v1/review-registry/claim-types/**", layer: "data_oracle" },
  { pattern: "/api/v1/projects/{projectId}/stale-signals", layer: "data_oracle" },
  { pattern: "/api/v1/stale-signals/**", layer: "data_oracle" },
  { pattern: "/api/v1/jurisdictions/**", layer: "data_oracle" },
  { pattern: "/api/v1/projects/{projectId}/readiness-assessments", layer: "data_oracle" },
  { pattern: "/api/v1/readiness-assessments/**", layer: "data_oracle" },
  { pattern: "/api/v1/review-registry/policy-sets/**", layer: "data_oracle" },
  { pattern: "/api/v1/source-reconciliation-tasks/**", layer: "data_oracle" },
  { pattern: "/api/v1/review-registry/jurisdiction-profiles/**", layer: "data_oracle" },

  // Asset Infrastructure
  { pattern: "/api/v1/registry-entries/**", layer: "asset_infrastructure" },
  { pattern: "/api/v1/anchor-batches/**", layer: "asset_infrastructure" },
  { pattern: "/api/v1/projects/{projectId}/gate-decisions/**", layer: "asset_infrastructure" },
  { pattern: "/api/v1/projects/{projectId}/lifecycle", layer: "asset_infrastructure" },
  { pattern: "/api/v1/projects/{projectId}/lifecycle-transitions", layer: "asset_infrastructure" },
  { pattern: "/api/v1/projects/{projectId}/offering-gate", layer: "asset_infrastructure" },
  { pattern: "/api/v1/governance/**", layer: "asset_infrastructure" },
  { pattern: "/api/v1/projects/{projectId}/disclosure-restrictions/**", layer: "asset_infrastructure" },
  { pattern: "/api/v1/disclosure-restrictions/**", layer: "asset_infrastructure" },

  // Application
  { pattern: "/api/v1/auth/**", layer: "application" },
  { pattern: "/api/v1/admin/**", layer: "application" },
  { pattern: "/api/v1/audit-events/**", layer: "application" },
  { pattern: "/api/v1/projects/{projectId}/exports/**", layer: "application" },
  { pattern: "/api/v1/outbox-backlog", layer: "application" },
  { pattern: "/api/v1/notifications/**", layer: "application" },
  { pattern: "/api/v1/me/**", layer: "application" },
  { pattern: "/api/v1/my-work", layer: "application" },
  { pattern: "/api/v1/public/**", layer: "application" },
];

/** Whether a layer rule pattern covers a route path. */
export function matchesLayerPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return path === base || path.startsWith(`${base}/`);
  }
  return path === pattern;
}

/** Every layer a route matches. Correct data yields exactly one. */
export function layersOf(route: Pick<RouteDefinition, "path">): PrimaryLayer[] {
  return ROUTE_LAYER_RULES.filter((rule) => matchesLayerPattern(rule.pattern, route.path)).map(
    (rule) => rule.layer,
  );
}

/** The route's primary layer, or null when the rules do not give exactly one. */
export function primaryLayerOf(route: Pick<RouteDefinition, "path">): PrimaryLayer | null {
  const layers = layersOf(route);
  return layers.length === 1 ? layers[0]! : null;
}
