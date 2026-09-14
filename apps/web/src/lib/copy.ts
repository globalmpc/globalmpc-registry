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
 * 인증 워크스페이스 navigation — spec 11 §11.2.
 *
 * 스펙의 10개와 이 목록이 일대일은 아니다. `Data Room`·`Verification`·
 * `Readiness & Gates`는 프로젝트 하위 화면이므로 프로젝트를 고르기 전에는 갈 곳이
 * 없다 — 전역 nav에 두면 "무엇의 Data Room인가"에 답이 없는 링크가 된다.
 *
 * **역할에 없는 메뉴는 보이지 않는다**(§11.2). `requires`는 그 화면이
 * 부르는 API의 action이고, 세션이 준 action 목록(`/auth/session`의 `actions`)으로
 * 거른다. 숨김은 보안 통제가 아니다 — 서버가 요청마다 다시 판정한다(02 §2.1).
 * `"subject"`는 역할이 아니라 지갑에 묶인 주체가 있으면 보이는 화면이다.
 *
 * 공개 화면은 여기에 두지 않는다. 로그인 뒤에도 `PUBLIC_NAV`가 따로 보인다.
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
  { href: "/w/registries", label: "Registries", requires: "registry.read" },
  { href: "/w/anchors", label: "Anchor", requires: "registry.read" },
  { href: "/w/integrations", label: "Integrations", requires: "authority.read" },
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
