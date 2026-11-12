# Reference content and navigation audit

Reviewed 2026-11-11 against private main `d4bdd179` and
https://mpc-registry-design.vercel.app/.

## Product direction retained from the user

Use the reference's project-first, task-first experience. Putting existing screens
inside a More menu does not finish the design work. Remove unnecessary content
and duplicate navigation; keep important work and record history discoverable.
Sample data alone cannot deliver the reference experience. This audit records
recommendations, not implemented UI changes or a new approval of product rules.

Correction to the earlier verbal comparison: our `/` already has the Verification
Registry heading and project directory. Public Explorer is a separate `/explorer`
route. The problem is overlapping entry points and missing contextual summaries,
not that the latest home is still only Public Explorer.

## Evidence and limits

Browser-inspected the prototype's public home/project on the preceding pass and,
on this pass, its workspace dashboard, requirements, impact, decision and upload
routes. Used only the prototype's explicitly permitted dummy sign-in and code;
no real account, message, file submission or production write was performed.
Prototype Data Steward is a simulated actor, not evidence of our app permissions.

Inspected our current main source and connected navigation/record components.
The previous live dev request timed out; this pass does not claim live dev,
mobile, keyboard, persistence or API security reproduction. No runtime code was
changed, so application tests/CI were not run. These are design findings and
source observations, not independently verified security defects.

## More: remove, move or retain

| Current content | Recommendation | Reason and required replacement |
| --- | --- | --- |
| Public More → Asset Registry | Remove from ordinary discovery | `app/asset-registry/page.tsx` explicitly describes an inactive feature. Keep existing deep links and the no-trading boundary; move internal release blockers to operator documentation. Removing a menu does not authorize asset issuance. |
| Public More → Explorer | Consolidate ordinary browsing into home | `/` and `/explorer` both use PublicRegistryBrowser for projects. Retain existing query/deep-link behavior and an advanced lookup route. |
| Public More → Verification Records | Place records beneath their project; keep advanced cross-project lookup | A separate top-level registry taxonomy makes visitors choose internal data categories before choosing a project. Do not orphan independently shared verification records. |
| Public More → Proof Verifier | Move to a clear record-level verification action plus advanced tools | `PublicRecord` already has integrity details. Standalone file/hash verification still has a different purpose and must remain reachable. |
| Public More → Governance | Move out of the routine project journey | It is a separate public protocol-proposal flow, not project gate approval. Do not remove published proposals or conflate the two decisions. |
| Public More → Disclosures & Incidents | Retain public discovery and project-specific history | Corrections, revocations and suspensions are material information. A global feed also covers events beyond a selected project; do not delete it merely because project history exists. |
| Terms, data handling, and support | Keep a clearly named footer link | Remove internal spec identifiers from ordinary explanation only after preserving meaningful restrictions and support access. Do not invent issued policies or contact details. |
| More project tools → Document status / Documents to recheck / Readiness / Gate decision | Remove duplicated menu entries once contextual links are in place | These overlap the sidebar and subnavigation. Select one main project navigation and retain task links at the relevant requirement/document/decision. |
| More project tools → CRE | Move into operator integration tools | An implementation acronym should not be a peer of normal evidence work. Preserve authorized operation and do not imply that CRE availability establishes chain support. |
| Load more / Show more | Retain pagination | These fetch remaining results; they are not the redundant More navigation the user wants simplified. |

Sources: `apps/web/src/components/PublicFooter.tsx`, `TopBar.tsx`,
`WorkspaceShell.tsx`, `project/ProjectWorkspaceNav.tsx`, `lib/copy.ts`, and
`app/page.tsx`. The home also repeats PUBLIC_NAV in its explanatory disclosure,
so changing only the footer would leave the same clutter elsewhere.

## Prioritized journey findings

1. **High product impact — competing navigation.** The authenticated top bar,
   workspace sidebar, four project tabs and secondary project tools all expose
   overlapping destinations. Requirements is a sidebar destination but activates
   Documents & evidence in the project tabs. Decision similarly activates Review
   evidence. Use one consistent project navigation and contextual actions; retain
   project switching and global work separately. Do not simply copy the prototype
   actor's available menus for every real role.
2. **High product impact — requirements do not lead directly to the next task.**
   The reference groups requirements by stage/category and places file count,
   Missing/Gap/In review/Accepted status and document entry together. Our
   requirements page wraps a browsable EvidenceLedger with search/status filters
   and generic links to files, reviews and readiness. Its rendered item cards do
   not provide the equivalent requirement-specific upload/review journey. Carry
   the exact project and definition/version through the next action; an aggregate
   readiness label must not become an individual review decision.
3. **High product impact — the decision entry has different scope.** The reference
   asks whether to advance to the next stage, lists blockers and offers the public
   preview. Our generic Decision sidebar link targets
   `gates/registry_publication`. Renaming it to a stage decision would misrepresent
   its authority. Show the actual gate name and scope, and link the configured
   stage gate only when the backend provides it.
4. **Medium product impact — public project summaries are incomplete relative to
   the reference.** Our home is already project-first, but reuses generic registry
   cards. The reference emphasizes stage, reviewed-result counts, current state
   and as-of time together. Populate only approved/publicly available summaries;
   missing coverage is unknown, not zero. Distinguish publication state, live
   adverse state, assessment time and chain confirmation.
5. **Medium product impact — work dashboard scope differs.** Our My Work is a
   cross-project assigned/waiting/unassigned queue. The reference dashboard is
   selected-project work with returned files, reasons, Fix links and deadlines.
   Both are useful, but they need clear scope and specific task links. Do not
   synthesize deadline cards from prototype dates or imply full counts for a
   truncated response.
6. **Medium product impact — Impact is only partially equivalent.** Our screen
   groups document impacts and dependencies; the reference also has a monitoring
   timeline for evidence, licence and credential expiry. Preserve our existing
   impact-resolution workflow, and add monitoring only for authoritative dates
   and enforceable effects. The prototype's expiry text is not a backend rule.
7. **Medium product impact — implementation details dominate ordinary copy.**
   Homepage explanatory tables repeat the footer; inactive-feature pages expose
   OD/spec codes; project tools expose CRE; publication exposes batch mechanics.
   Remove repeated explanations and relocate diagnostic fields. Keep review scope,
   limitations, adverse warnings, exact disclosure inspection and integrity checks
   accessible. The tenant-wide anchor batch action needs its true scope stated;
   this audit did not inspect a prototype anchoring flow and claims no parity.
8. **Medium product impact — demo data underrepresents the target journey.**
   INPUT/REVIEW/PUBLIC samples demonstrate a minimal pipeline, not multiple
   requirement groups, returned evidence, expiry, N/A and historical changes.
   Future additive fixtures should cover those states through real authorized
   paths without resetting edited demos, generating fake chain confirmations or
   granting prototype identities access.

## Decision contract for subsequent implementation

| Identity or state | Authority/time basis | Allowed presentation |
| --- | --- | --- |
| Menu visibility | Live server actions and selected project | Removing or moving a link never changes API permissions; retain account/MFA recovery paths |
| Requirement | Catalog definition/version and real scoped evidence | Preserve Missing, rejected, conflicting, stale, reviewed and approved N/A distinctions |
| Stage/gate | Configured gate and signed decision | Never manufacture eight operational stages from prototype array positions; no publication-gate substitution |
| Public record | Approved immutable projection plus separately dated warnings | Keep historic versions and adverse warnings; never fetch private data to fill a visual gap |
| Anchor | Tenant-wide batch and chain receipt/finality | Publication, batch creation, inclusion and confirmation remain separate states |
| Empty/error | Actual request outcome | Failure and unavailable information must not render as zero or success |

## Acceptance checks for a UI follow-up

- One consistent selected-project navigation; old public and operational URLs
  remain usable or have deliberate compatible redirects.
- Each visible next action targets the correct project, requirement and file;
  wrong-role and cross-tenant API requests remain denied.
- Required notices, historical records, revocations, support and standalone proof
  checks remain reachable after menu removal.
- Verify desktop/mobile navigation, keyboard/focus behavior, empty/error states,
  back/refresh and project/account switching in a real app browser.
- Exercise upload → review → configured gate → independent publication → proof
  using real fixtures. Preserve retries, additive demo behavior and signed history.
- Run focused navigation/journey tests and applicable repository checks for the
  actual implementation revision. Human security review remains required for
  changes to authorization, sensitive state or decision interpretation.

UI implementation and the above runtime verification remain pending. This audit
must not be used as evidence that the current application matches the reference.

## Implementation contract (2026-11-11)

This follow-up implements navigation cleanup and evidence-stage progress. The
current evaluator chooses the last passing configured stage as `currentStage`;
it does not supply an approved operational stage. UI labels therefore explicitly
say evidence stage, not signed decision. The first non-passing configured stage
is highlighted even when a later stage passes. Reviewed/required counts count
logical evidence types, not gate requirements; `missing` is also a type list and
must not be presented as the number of blocked requirements. Unknown counts
never become zero. Approved public snapshots are dated and distinct from live
warnings. No publication bytes, evaluator semantics or permission rules change.

Private list progress uses the existing authorized read endpoint. Account/project
identity changes discard pending results; denied/failed reads show unavailable,
not an unconfigured stage. Public progress never requests this private endpoint.

Initial implementation checks: web typecheck passed; focused progress/navigation
23 tests passed; full web pass before the final new tests was 503/503. Built-server
browser checks passed 19/19 (public routes, document status, navigation, real
upload/retry/reuse, disclosure publication, anonymous history and mobile overflow).
Initial web failures were removed-menu selectors; these were replaced with checks
of the retained sidebar and contextual document path. An initial new test used an
unsupported Testing Library `exact` option; corrected and typechecked. Full DB
coverage and configured-stage browser scenarios are running at PR creation.

Primary review follow-up: document/claim and upload routes retain the appropriate
sidebar selection after removing the duplicate tabs. Configured stages are not
numbered by array position. An additional regression keeps a fully reviewed but
non-passing stage in the attention state. The built browser verifies the exact
reviewed/max counts in both private and public project lists against a real
approved stage fixture, rather than only checking for static labels.

The configured-stage/expiry/revocation journeys and WCAG batch passed 30/30; the
reviewed-build journey batch passed 4/4, including list progress assertions and
screenshots. One reviewed-build run logged a Next server aborted ECONNRESET while
tests continued successfully; this is recorded separately from assertion results
and a focused reproduction is being checked. No error handling was suppressed.

The audit's broader recommendations (requirement-specific editing, project-scoped
dashboard deadlines, monitoring and richer demo scenarios) remain separate work;
this PR implements navigation cleanup and honest project evidence-stage progress.

Final local verification: 255 test files / 4,072 tests passed with PostgreSQL and
zero skips; line coverage 95.80%, branch coverage 86.05%. The run began at the
initial feature commit and completed with the navigation follow-up present;
focused follow-up regressions also passed (9/9). Full typecheck, production build,
OpenAPI drift (214 routes) and three brand checks passed. Browser evidence covers
49 distinct existing journeys plus the reviewed-build four-scenario rerun. The
focused rerun of the previously logged aborted request passed without ECONNRESET;
its underlying intermittent cause is unconfirmed, not declared fixed.

Reviewed implementation source: `3b3fbb62`. Public and workspace progress screenshot
artifacts were personally inspected. Public integrity history and private approval
boundaries were exercised by the existing real API journeys. At that earlier
revision (`3b3fbb62`) no API, DB schema, API contract, role or signed serialization
changed. The later saved-summary implementation (`b96e2d46`) adds a private API
service and optional `stageProgress` response/contract/OpenAPI field; independent
human security review of that addition remains required. Runtime checks used isolated databases and
ports, not shared dev. CI and independent human review remain pending at this
record; external scores are not inferred from local checks. Latest CI status is
reported on PR #136 rather than copied as a permanent passing claim here.

## Duno navigation-consumer follow-up (2026-11-11)

Finding: the signed-in footer journey in `workspace-screens.spec.ts` retained
`Proof Verifier` as a link name after the link became `Verify a proof`. The
unchanged page heading is still `Proof Verifier`; blindly replacing both would
hide the distinction. The original test was reproduced against the built app and
failed at its old-name click as reported.

Searched old link names, removed menus and shared navigation helpers across all
web source, unit tests and E2E specs. The affected browser inventory for this
follow-up is `workspace-screens.spec.ts`, `public-surface.spec.ts` and
`project-registry.spec.ts` (shared workspace navigation). Other old-name matches
are the intentional verifier page heading or assertions that removed menus are
absent, not stale navigation selectors.

The signed-in journey now checks all four advanced footer destinations using
independent literal accessible names, their URLs, unchanged page headings and
menu dismissal. Legal/support access is tested without opening the old menu,
matching its always-visible placement. Existing role-visibility and negative
project-evidence assertions remain intact.

Validation: complete built-server execution of all three files passed 38/38 with
an isolated PostgreSQL database, followed by primary diff review and a clean
whitespace check. Web typecheck passed. No application/API/DB/permission code
changed, so unrelated full coverage was not repeated; the earlier measured
coverage remains historical evidence for the implementation. Added navigation
consumer-search and complete-affected-spec requirements to `apps/web/AGENTS.md`.
CI and the requested Duno re-review must be assessed on the pushed revision.

## Progress request budget decision (2026-11-11)

| Case | Authority / lifetime | Required result |
| --- | --- | --- |
| Many visible rows or rapid filter/remount | Shared page-runtime request budget, no cached identity/results | At most two live progress reads; visibility alone is not a concurrency bound |
| Row/project/account removed while waiting | Row effect cancellation; tenant/subject keyed row | Remove its queued request before it reaches the API; discard old results |
| Row removed during a running read | Running API request keeps its slot until it settles | Do not admit more work merely because the browser stopped displaying a row |
| 429 from a read | Existing server rate limit | Drop queued reads, pause new automatic progress reads for 60 seconds; no timers or retry loops |
| Paused progress | Optional summary, not the project itself | Keep the row and requirement navigation usable; never show zero or an error storm |
| Cooldown ends | New explicit demand only | No queued replay or automatic retry; API still enforces access and rate limits |

Root cause: viewport deferral was treated as a load bound without tracing each row
to the live computeEvidenceLedger transaction. The previous focused fix addressed
label consumers but did not revisit workload scaling. This follow-up keeps the
existing authorization and evaluator and adds a shared page-runtime two-request budget.
It bounds concurrency, not total O(N) computations; a batched/persisted summary is
a future optimization. Cancellation cannot guarantee server-side SQL termination.

Before/after regression: rendering 50 simultaneous rows started 50 HTTP reads in
the old component (expected 2, observed 50); the same test passes with the shared
budget. Deferred-response tests cover 100 queued rows, peak concurrency, running
versus queued cancellation, replacement demand, unchanged cookie markers across
account changes, errors, rate limiting and cooldown without automatic replay.

The primary review also checked that the public directory still uses approved
projection data without private reads, existing project authorization remains
server-enforced, and the list keeps its normal project links on throttling.
Focused scheduler/component tests passed 10/10; the full web suite passed 515/515
before the final account-switch regression was added. The production build and
35 complete browser scenarios passed, including six real projects in a tall
viewport with delayed 429 responses: only two automatic requests start, all six
rows remain navigable, and explicit requirements navigation still loads normally.
Full typecheck, OpenAPI drift and brand checks passed; DB coverage is running.
This is a concurrency fix, not a claim that O(N) live evaluation has been removed.

### Persisted list summaries and explicit recovery (follow-up contract)

| Case / identity | Authority and time basis | Input scope | Outcome |
| --- | --- | --- | --- |
| Private project list | Current session, exact project-scoped `readiness.read`, tenant RLS | Only authorized IDs within the capped list; latest stored snapshot by creation time | One batched read; no evaluation or persistence on navigation |
| Saved stage summary | Frozen snapshot, explicitly dated; not current approval or health | Allowlisted stage fields only; no claim/reviewer/input-basis data | Display immediately as saved and possibly outdated; malformed/absent snapshots show unavailable |
| Explicit refresh | Existing live ledger endpoint authority | Clicked project only; shared two-request ceiling | Live result replaces saved display for this mounted identity only |
| 429 and retry | Shared page-runtime cooldown | User retries only; no replay timer | Retry stays available, but no request until cooldown expires |
| Project/account change | Tenant/subject/project identity, not cookie marker | Discard old requests/results; queued work cancelled | No automatic live evaluation or cross-identity reuse |

Acceptance: opening or scrolling any list generates zero live ledger evaluations; saved progress remains visible at a glance. Explicit refresh/retry works without reload, including after 429. Verify real RLS runtime permissions and anonymous/wrong-role/other-tenant/project scope, malformed/absent summaries, identity changes, and complete affected browser files. This replaces the earlier O(N) automatic workload; a concurrency ceiling alone was insufficient. Independent human review of the new private response field remains required before merge.

Focused verification: 10 web regression tests and 25 real-DB project/API tests passed; full typecheck and production web build passed. The new saved-list regression fails against the prior component and passes after the change. Initial API run caught a removed `sql.array()` call in postgres v4 and a missing `0x` prefix in a synthetic hash; corrected both and reran all 25. An initial typecheck also preceded the contract edit after the environment rejected the unavailable `python` alias; reran using `python3` and verified the complete change. No bypass-RLS role or migration changes. Broader CI/browser/coverage results follow below.

Final verification of implementation b96e2d46:
- Full DB-backed suite: **4,083 tests in 257 files passed, zero skips**; lines **95.80%**, branches **86.05%**. Full web suite separately passed **516/516**.
- Production browser run: **36/36**, covering all five complete files `project-progress-budget`, `evidence-ledger`, `reference-experience`, `workspace-screens`, and `public-surface`. The budget case verifies zero automatic reads, two explicit requests, no request on early retry, then successful real API recovery after advancing the browser clock past cooldown without remounting. The ledger journey verifies saved private and approved public counts, signed review/publication, proof and expiry warnings. Private/public list screenshots were produced; the private screenshot was inspected personally.
- Full typecheck, production build, OpenAPI drift (214 routes) and three brand assets passed. OpenAPI semantic diff is only the optional nullable stage summary in list-item consumers.
- Final personal review covered the complete feature diff and connected authorization/navigation/evidence flows. List selection is capped before summary lookup, snapshots use indexed lateral latest-record reads, schema parsing strips unlisted fields, and the existing workspace tenant/subject key remounts private content on identity changes. Filter requests now discard obsolete responses too. The evaluated timestamp describes saved evidence, not live health or signed gate authority.
- Browser teardown's SIGTERM messages were marked `expected=true`; the controller exited successfully. No dev database was used. Local run logs: `/tmp/registry-saved-{coverage,web,browser,typecheck,build,openapi-check,brand}.log`.
- Remote checks at b96e2d46: basic/dependency/secret checks passed; DB/browser/unit/Sonar/JavaScript analysis still pending at inspection. Code-scanning alerts were unavailable (HTTP 403, Code Security not enabled for this private repository). No current CodeFactor score is claimed. Independent human security review remains pending for the new private response field; automated/self-review does not substitute for it. Both new Duno threads received English fix/verification replies and were resolved.

## Latest-snapshot ties and coverage-lock isolation

| Case | Authority / identity | Expected result |
| --- | --- | --- |
| Equal snapshot creation timestamps | Existing worker convention: `created_at DESC, id DESC`; UUID ordering, not insertion order | Private list selects the same highest-ID snapshot; evaluated time does not override creation order |
| Latest tied snapshot malformed | Same total order, latest snapshot only | Unavailable summary, never an older passing fallback |
| Coverage lock outside this checkout | Vitest lock identifies an absolute report path and PID, which can be reused across runner lifetimes | Use a checkout-local temp namespace cleared by checkout cleanup; leave foreign locks untouched |
| Concurrent coverage inside one checkout | Same report path and checkout-local temp namespace | Preserve Vitest's mutual-exclusion refusal; do not delete active locks or weaken checks |

CI run 42964059962 failed before any tests: Vitest 5.1 reported a coverage/app lock owned by PID 878. The job's checkout removed coverage/node_modules but the lock lives in the OS temp directory. The log does not establish whether that PID was a surviving Vitest or a reused PID. Both require isolating unrelated runner temp state while preserving same-checkout exclusion. Browser CI passed; this was exit 1, not exit 137/OOM.

The tie regression failed on the previous query (returned reviewedItems=1 instead of 0), then passed with the worker's descending UUID tie-breaker. It also rejects a malformed highest-ID snapshot rather than falling back. The real Vitest CLI regression reproduces a live foreign-temp lock, verifies the corrected invocation succeeds without deleting it, and verifies a live same-checkout lock still blocks coverage. The coverage command runs this regression automatically and preserves report locations, reporter arguments, full scope and thresholds. The exact per-project readiness authorization remains intentional defense against future divergence from project.read; it is not a new permission grant.

Duno's next pass found no implementation/security blocker but flagged the lock
fixture's 30-second startup watchdog and dependency on Vitest's internal protocol.
The fixture now permits 120 seconds for cold CLI startup, reports spawn errors
explicitly, and documents mandatory protocol review on every Vitest/coverage-v8
upgrade. This adjusts test startup only, not service timing or coverage thresholds.
Full local verification at f0d8ac6b passed 4,084 tests with zero skips, 95.80% lines
and 86.05% branches; all 26 process-lifecycle regressions passed too. CI's corrected
DB job reached report upload. Separate CodeQL OOM (137, oom_kill 0→1) and a
contemporaneous browser process-test timeout are recorded as environment failures;
their final rerun results are tracked on PR #136, not assumed successful here.
