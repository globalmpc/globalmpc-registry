/**
 * Chrome copy — OD-30.
 *
 * **The service runs in English only.** There is no locale toggle and no
 * runtime translation: the workspace renders one language, so a string in the
 * source is the string on screen.
 *
 * What stays here is the copy the chrome repeats — navigation labels and
 * session states. It is a single registry rather than local arrays in each
 * component because a destination renamed in one place and not the other reads
 * as two different destinations (@mpc/design patterns.md, "Chrome").
 *
 * **Boundary copy is not defined here.** `@mpc/ui`'s `REQUIRED_BOUNDARY_COPY`
 * is the origin; restating it per screen defeats the point of enforcing it.
 */

/**
 * Authenticated workspace navigation — spec 11 §11.2.
 *
 * `Data Room`, `Verification`, and `Readiness & Gates` are project sub-screens. Their global
 * entries open a project picker that answers "whose Data Room?" and lists only the projects the
 * session can open, so the nav matches the spec's ten items without links that lead nowhere.
 * `Authorities` sits beside `Integrations`: the authority catalog is its own screen (§11.10).
 *
 * **Menus outside the user's roles are hidden** (§11.2). `requires` is the API action the
 * screen calls, filtered against the action list the session provides (`actions` from `/auth/session`).
 * Hiding is not a security control — the server re-checks every request (02 §2.1).
 * `"subject"` is not a role: the screen is shown when a subject is bound to the wallet.
 *
 * Public screens do not belong here. `PUBLIC_NAV` is shown separately even after login.
 */
export interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly requires: string;
}

export const NAV: readonly NavEntry[] = [
  { href: "/w/work", label: "My Work", requires: "project.read" },
  { href: "/w/activity", label: "My Activity", requires: "subject" },
  { href: "/w/notifications", label: "Notifications", requires: "project.read" },
  { href: "/w/projects", label: "Projects", requires: "project.read" },
  { href: "/w/data-room", label: "Data Room", requires: "evidence.read" },
  { href: "/w/verification", label: "Verification", requires: "verification.read" },
  { href: "/w/readiness", label: "Readiness & Gates", requires: "readiness.read" },
  { href: "/w/registries", label: "Registries", requires: "registry.read" },
  { href: "/w/anchors", label: "Anchor", requires: "registry.read" },
  { href: "/w/integrations", label: "Integrations", requires: "authority.read" },
  { href: "/w/authorities", label: "Authorities", requires: "authority.read" },
  { href: "/w/governance", label: "Governance", requires: "governance.read" },
  { href: "/w/audit", label: "Audit", requires: "audit.read" },
  { href: "/w/admin", label: "Admin", requires: "admin.read" },
];

/**
 * The public surface — spec 11 §11.2.
 *
 * These seven are reachable with no account. They are listed here rather than
 * filtered out of `NAV` because they are not a subset of the workspace: the
 * public site answers "what has been published", the workspace answers "what am
 * I working on". Deriving one from the other made the public surface look like
 * a permissions leftover, and for a long time it held exactly one entry.
 */
export const PUBLIC_NAV = [
  { href: "/explorer", label: "Explorer" },
  { href: "/explorer/verifications", label: "Verification Records" },
  { href: "/asset-registry", label: "Asset Registry" },
  { href: "/verify", label: "Proof Verifier" },
  { href: "/governance", label: "Governance" },
  { href: "/disclosures", label: "Disclosures & Incidents" },
] as const;

export const COPY = {
  productName: "Registry Workspace",
  session: {
    disconnect: "Disconnect",
    none: "No account connected",
    required: "No account is connected.",
    connect: "Connect an account →",
    noRoles: "No roles",
    requestAccess: "Request access",
    publicMenu: "Public registry",
  },
  empty: {
    noData: "There is no data here. This is not a permission problem.",
  },
} as const;
