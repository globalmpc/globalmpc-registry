# CodeFactor active issues — 2026-11-10

## Scope and acceptance

The public CodeFactor analysis for `2cc55917d6aa2b45df2949226ea419cdd6a4b5b8`
reported 34 active issues: 21 complex methods and 13 duplicate CSS selectors.
Collected all four issue pages, not just the first page. This change uses private
`main` at `f807d6ea7ec954ea7ad60121305c753e76283122`, retaining fixes already
present there. No exclusions, suppressions, quality thresholds or dependencies change.

Expected behavior: preserve authentication, MFA, wallet replacement, document
registration/versioning, public search/proofs, CRE report generation, scanner leases,
anchor submission/finality/reconciliation and historical publication warnings.
Acceptance: address every collected finding, keep helper complexity at most 15 in
local Lizard analysis, remove the reported same-scope CSS duplicates, preserve
computed responsive styles and pass the required checks. Local tool results do not
replace CodeFactor analysis of the resulting public revision.

## Preserved decision contracts

| Identity / case | Authority and time basis | Input scope | Priority / invariant |
| --- | --- | --- | --- |
| Human versus service bearer | Existing server token resolvers and live route policy | Same request method, route, token and scopes | Sessionless bypass first; service tokens never fall through to human authentication; MFA/recovery restrictions unchanged |
| Catalog evidence | Authorized transaction and project; approved effective catalog | Same project receipt and active scanned uploads, same locks | Reserved-key correction guard, paired values, catalog validation, then receipt/documents; no new identity or tenant source |
| Source observation | Existing tenant/project/query locks and previous successful receipt | Same query scope, hashes and timestamps | Out-of-order overrides outcome; failure never replaces successful baseline; only relevant changes/no-record mark claims stale |
| Anchor receipt and chain move | Old chain's live policy, stored transaction and tracked hashes | Same receipt, root, contract, depth, finality and candidate contracts | Terminal state first; revert before finality; no confirmation without root; check tracked-send finality before move |
| Scanner lease | Trusted worker tenant and exact existing lease | Same tenant transaction context, upload/version/attempt/lease token | Finish transport cancellation before failure; report through API; refund only existing unavailable/401 cases |
| UI state | Existing session and API projection, same hook order | Same render-time values and callbacks | Plain local render helpers keep input/component identity; no new client authority; all public limitations remain visible |
| Historical publication | Frozen approved catalog snapshot versus live legacy facts | Same isolated fixture, frozen inputs and hashes | Fixture construction only is extracted; all original scenario assertions and triggers remain |

## Finding inventory

Locations below are those reported by the collected public analysis; lines move in
the private implementation. Each listed issue is Minor severity.

| Rule | Reported location | Method / selector |
| --- | --- | --- |
| Complexity 18 | `apps/anchor-worker/src/anchor-submitter.ts:716` | `async function submitPending(` |
| Complexity 24 | `apps/anchor-worker/src/anchor-submitter.ts:1434` | `async function trackPending(` |
| Complexity 24 | `apps/anchor-worker/src/anchor-submitter.ts:2120` | `async function processChainMove(` |
| Complexity 20 | `apps/web/src/app/w/projects/[id]/documents/[uploadId]/page.tsx:47` | `export default function DocumentPage({` |
| Duplicate selector | `apps/web/src/app/globals.css:620` | `.main { max-width: 1248px; padding-top: 36px; }` |
| Duplicate selector | `apps/web/src/app/globals.css:621` | `.page-head { margin-bottom: 28px; align-items: flex-start; }` |
| Duplicate selector | `apps/web/src/app/globals.css:626` | `thead th { background: transparent; padding: 10px 12px; }` |
| Duplicate selector | `apps/web/src/app/globals.css:628` | `.dl { row-gap: 10px; }` |
| Duplicate selector | `apps/web/src/app/globals.css:631` | `.dialog-backdrop .panel { background: var(--surface-elevated); border: 1px solid var(--border); border-radius:...` |
| Duplicate selector | `apps/web/src/app/globals.css:647` | `.main { max-width: 1280px; padding-left: 16px; padding-right: 16px; padding-top: 38px; }` |
| Duplicate selector | `apps/web/src/app/globals.css:648` | `.topbar { min-height: 64px; align-items: center; padding-left: max(24px, calc((100vw - 1248px) / 2)); padding-...` |
| Duplicate selector | `apps/web/src/app/globals.css:650` | `.public-directory-heading { margin: 0 0 18px; }` |
| Duplicate selector | `apps/web/src/app/globals.css:651` | `.public-directory-heading h1 { font-size: 1.875rem; line-height: 1.3; }` |
| Duplicate selector | `apps/web/src/app/globals.css:654` | `.public-directory-search { margin-bottom: 30px; }` |
| Duplicate selector | `apps/web/src/app/globals.css:655` | `.public-project-row { padding-top: 16px; padding-bottom: 16px; min-height: 80px; }` |
| Complexity 16 | `apps/api/src/server.ts:392` | `  app.addHook("preParsing", async (request) => {` |
| Complexity 17 | `apps/web/src/components/PublicRecord.tsx:29` | `export function PublicRecord({ entry, browsableEvidence = false }: { readonly entry: PublicProjection; readonl...` |
| Duplicate selector | `apps/web/src/app/reference-layout.css:547` | `.public-project-row {` |
| Duplicate selector | `apps/web/src/app/reference-layout.css:560` | `.workspace-content .project-navigation-main {` |
| Complexity 18 | `apps/anchor-worker/src/anchor-config.ts:95` | `export function loadAnchorConfig(env: AnchorEnv): AnchorConfig {` |
| Complexity 16 | `apps/web/src/components/PublicRegistryBrowser.tsx:46` | `export function PublicRegistryBrowser({` |
| Complexity 17 | `apps/scan-worker/src/scan-worker.ts:152` | `export async function scanOnce(` |
| Complexity 21 | `apps/web/src/components/TopBar.tsx:25` | `export function TopBar() {` |
| Complexity 22 | `apps/web/src/components/ErrorNotice.tsx:22` | `export function ErrorNotice({ error, context }: { error: unknown; context?: "signing" }) {` |
| Complexity 17 | `apps/anchor-worker/src/anchor-state.ts:113` | `export function trackTransaction(input: TrackInput): TrackResult {` |
| Complexity 21 | `apps/web/src/components/settings/WalletsSection.tsx:48` | `export function WalletsSection({` |
| Complexity 18 | `apps/web/src/app/w/projects/[id]/register/page.tsx:14` | `export default function RegisterEvidencePage({` |
| Complexity 16 | `apps/anchor-worker/test/dev-keys.test.ts:40` | `function committedFixtureKeys(): { source: string; key: `0x${string}` }[] {` |
| Complexity 17 | `apps/api/test/historical-catalog-applicability.test.ts:41` | `    await fx.sql.begin(async tx => {` |
| Complexity 19 | `apps/api/src/services/catalog-claims.ts:47` | `export async function resolveCatalogClaim(` |
| Complexity 18 | `apps/web/src/app/auth/mfa/page.tsx:30` | `export default function SecondFactorPage() {` |
| Complexity 21 | `apps/web/src/app/w/projects/[id]/cre/page.tsx:17` | `export default function CrePage({ params }: { params: Promise<{ id: string }> }) {` |
| Complexity 16 | `apps/api/src/services/source-observations.ts:15` | `export async function recordSourceObservation(` |
| Complexity 17 | `apps/web/src/lib/stream-upload.ts:55` | `export async function forwardStreamUpload(` |

## Verification and review

- Focused anchor, scan (including NOBYPASSRLS runtime-role coverage), historical
  publication, auth UI, public records, document, CRE and upload tests: 571 passed.
- Additional direct API/negative service-token, catalog, historical correction,
  reserved-key and source-observation tests plus account/navigation UI: 106 passed.
- Typecheck passed. Initial extraction exposed closure-narrowing errors; explicit
  helper arguments and return values fixed them before the passing run.
- Local Lizard 1.25.1 analysis of every reported TypeScript file: no complexity >15.
- Stylelint `no-duplicate-selectors` on both reported stylesheets: passed.
- Chromium computed-style comparison of representative header, directory, table,
  definition list, workspace navigation, help/work grid and dialog elements at
  375/640/641/760/1024/1440px: zero differences. Reproduce from the repo root with
  `node scripts/verify-codefactor-css.mjs f807d6ea7ec954ea7ad60121305c753e76283122`.
  Initial comparison caught an incorrect merge of a grouped `.help-grid` selector;
  corrected it and reran the comparison. Mobile `.main` keeps the effective 38px
  top padding from the old final override. The comparison also loads the real
  shared design tokens/utilities so variable-dependent declarations are exercised.
- Initial shell Node 26.1.0 was below the configured supported patch. Verification
  uses installed Node 24.22.1. Dependency installation ignored esbuild's build
  script under the existing pnpm policy; tests executed successfully.
- Primary self-review traced the complete diff and connected error/authorization,
  lease, receipt, source-history and render flows. Independent human security
  review is required before merge for the authentication/sensitive-data paths.
- Broader checks, CI and fresh external CodeFactor analysis: pending at PR creation.

## Review follow-up

Duno reviewed implementation commit `ead7ddf5` in its security/integration and
correctness/quality passes with zero findings (2026-11-10 10:41 UTC). This is a
static automated review, not the independent human security approval required
before merge. Request another Duno review on the final evidence/script revision.

`pnpm audit --audit-level high` exited 0 with the existing
`GHSA-mrhx-c7xc-m3w5` exception (Chainlink SDK's Zod 3 copy); no new exception was
added. GitHub's code-scanning alerts API returned 403 because Code Security is
not enabled on the private repository; inspect the workflow's retained SARIF
artifacts instead of treating successful job status as absence of findings.

## Final CSS counterexample

The final primary review expanded the browser fixture to put a dialog inside
another panel. That counterexample failed against the first consolidation:
`.panel .panel` now followed the early merged `.dialog-backdrop .panel` rule and
overrode its padding. Keep the consolidated dialog rule at the old final override
location instead. The expanded computed-style comparison then passes all six
widths. This is a cascade-order correction, with no new selector or suppression.
Request Duno again for this correction; do not reuse its earlier clean verdict as
approval of the new revision.
