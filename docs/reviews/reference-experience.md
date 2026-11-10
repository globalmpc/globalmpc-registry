# Registry reference experience

Baseline: `e0df7de` (2026-11-09). Reference: https://mpc-registry-design.vercel.app/.
Review covers existing account/MFA screens as well as discovery, project work,
requirements, documents, review, decisions, publication and operational screens.
The original checkout was behind main; account authentication and the discovery
changes in #104, #116 and #117 already exist in this baseline.

## Expected behavior and boundaries

| Case / namespace | Authority | Frozen versus live | Inputs and priority |
| --- | --- | --- | --- |
| Workspace destinations | Server session actions | Live; no locally asserted roles | Incomplete MFA/access pending remains behind WorkspaceGate; navigation never grants access |
| Project selection | Authorized project list and project API | Live; route is the selection | Switching projects changes the route, clears prior context, and never retains another project's result after a failed lookup |
| Evidence item | Catalog claim type plus catalog version | Approved public snapshot or current private assessment | Reviewed, missing, rejected, conflict and N/A remain distinct; file processing is not review approval |
| Stage | Server assessment gate ID and rule version | Snapshot's evaluated time | Render only configured assessed stages; do not invent the prototype's eight gates or infer item membership from an array index |
| Public result | Approved public projection | Frozen result plus separately dated live warnings | Never fetch private claims, identities or files on public pages; current warnings do not rewrite approved results |
| Draft preview | Draft projection | Pending; not public or anchored | The preview is labeled draft; it cannot request a proof or imply publication |
| Loading or failure | Request outcome | Live | Pending and errors outrank empty/success messages; stale responses cannot replace newer selections |

## Acceptance and verification scope

- Every existing workspace route inherits the same responsive sidebar and content
  hierarchy; project context and current destination remain apparent.
- Role-free account/settings paths remain usable; MFA and access-pending behavior
  and API authorization are preserved.
- Public project details foreground identity, publication state, assessed stages,
  expandable evidence and current warnings, with integrity/history reachable.
- Requirements expose real server item states and scoped actions without presenting
  readiness as a human decision or treating unconfigured stages as reached.
- Dashboard counts use real queues; no invented deadlines, sample records or roles.
- Sign-in/MFA/invitation/settings use a readable, bounded form layout; email-code,
  identity-provider, passkey and recovery behavior is preserved.
- Desktop/mobile browser checks, focused component regression tests, existing web
  tests, typecheck, build, brand/OpenAPI checks and database-backed checks apply.
- Changes affecting presentation of sensitive/authenticated state require human
  independent security review before merge. This PR does not deploy or merge.

## Primary-agent review

Counterexamples checked: account switch on the same route (the HttpOnly session
marker is deliberately constant, so context is keyed by subject/tenant, not the
marker); project switch during a pending request; a denied public-list request;
classification failing after upload; revoked role assignments in a different
project; a private draft preview requesting a public proof; and missing public
coverage metadata. Context is reset on identity/project changes, retries reuse
idempotency keys, and no prototype result or gate is synthesized.

The original browser attempt assumed seed projects existed and failed on an empty
project list. The regression now creates its own project through the real UI.
Existing text assertions were adjusted for the renamed Lifecycle filter and the
visual draft heading; public version assertions remain in place.

## Verification evidence

- Node 24.22.1; isolated worktree and dedicated `registry_reference_test` /
  `registry_reference_e2e` databases, separate from development data.
- `pnpm check` passed: 250 test files, 4,028 tests, typechecks, OpenAPI drift
  (214 routes) and brand assets. Later focused context/overview/public-record
  regressions also passed (39 tests).
- Production webpack build passed. Built-server browser run passed 11 scenarios,
  including real private upload/classification persistence, registration → signed
  review → gate decision → independent disclosure approval → publication → pending
  anchor/proof, public sharing/history, mobile overflow and WCAG checks.
- Initial broader browser run: 40 passed, two old selectors failed after the
  intentional Stage→Lifecycle rename and sidebar move. Both scenarios passed in
  the built-server rerun. Development hot reload logged a hook-dependency-size
  warning while implementation was changing; the stable built run has no HMR.
- Primary review found the account marker is constant: context is keyed by
  tenant/subject instead. Team loading now first verifies access to the selected
  project, before reading the administrator directory. Negative regression tests
  cover these boundaries.
- Coverage and CI are reported for their measured revisions in the PR, not inferred
  from a passing individual job. No checks, thresholds or production source scope
  have been reduced.
- The external quality summary reported a pre-existing `.env.example` signer as a
  secret; it is the standard public local Anvil signer (verified without logging
  its key) and this PR does not change it. That report also returned a Sonar scan
  error and an inconsistent dependency summary (threshold exceeded with zero
  findings). These are unavailable/inconsistent external evidence, not clean scans.
- GitHub code-scanning alert access returned HTTP 403 because Code Security is not
  enabled for this private repository. A successful analysis job alone is not
  evidence that its alerts are clear. Independent human security approval remains
  pending; neither merge nor deployment is performed here.
- Completed local coverage run: 250 files / 4,030 tests passed, zero skipped,
  application line coverage 95.79% (13,389 / 13,977), above the unchanged 90% floor.
  An earlier coverage invocation was stopped to keep DB runs serialized; the
  completed run started only after `pnpm check` exited successfully.
- New components/styles were formatted for review; final focused tests (39),
  web typecheck and production build passed after the project-access validation
  and formatting. A final frozen-source coverage/browser run is tracked in the PR.
- Stable production-server verification additionally passed all 30 existing
  accessibility and evidence-ledger lifecycle scenarios: real catalog/stage rules,
  signed scope, independent publication, inclusion proof, expiry, revocation,
  replacement and mobile current warnings. The stage assertion checks the same
  rule/status/coverage values through the new expandable cards.
- Final visual review removed a detached separator in evidence rows and empty
  history-table headers; absent audit roles are labeled unrecorded rather than
  attributed to the system. Focused UI regressions (40) and typecheck passed.

## Upload recovery follow-up (2026-11-10)

| Case | Authority / identity | Live inputs and required result |
| --- | --- | --- |
| Scanning changes only state/version | Server upload ID in the selected project; live version | On 412 reload the focused document, preserve classification intent, retry the current version with a new key; never re-upload |
| A profile PATCH may have committed before transport failure | Same upload and unchanged requested payload | Retry the original version/payload/key; if a reload already has the requested fields, finish without another write |
| Another editor changes classification | Current server fields versus the attempted baseline | Do not silently overwrite; show current fields and require an explicit retry |
| Server rejects classification | Shared request schema and real calendar date | Validate before creating an upload; after rejection keep inputs editable and renew the profile key when the normalized payload changes |
| Focused document missing, revoked or unusable | Live server document state and project scope | Stop without a profile write or a replacement upload; keep a route to the stored document |

Regression scope includes a scanner interleaving between POST and PATCH, a scan
between network retry attempts, transport failure after a committed PATCH, invalid
and corrected inputs, and an unrelated editor's update. SMTP CI must also verify
peer-close behavior without suppressing unhandled errors. CodeQL's analysis scope
and finding gates must remain unchanged while diagnosing resource-related termination.

CI failure evidence for `6395e4b`: application coverage completed all 4,030 tests
at 95.8%, but an unhandled peer `ECONNRESET` in the SMTP test made the job fail.
SMTP now drains the QUIT reply after DATA acceptance; a failed QUIT cannot resend
already accepted mail. The fixture captures peer errors and asserts none at
teardown rather than suppressing Vitest errors. A gated QUIT regression fails
against the old implementation and passes with the fix.

CodeQL's JavaScript query process was killed (137) with RAM=3072 and one thread;
no OOM-counter evidence was retained, so its precise killer is unverified. The
hosted-runner experiment completed CodeQL, but does not prove an OOM or ARM defect.
Per the user's preference, manager PR #290 now retains the existing `quality-check`
runner and adds memory/cgroup diagnostics before and after analysis, including
failed analysis. RAM, languages, queries, SARIF and severity gates are unchanged.
This is instrumentation rather than a verified fix for termination. The generated
test workflow is pinned below without publishing the manager's machine-owned
release branch. Reviewed generated ref: `bd9d30348ab3ac9900549dfa1aa39db048067215`.
The generated security job matches the source and retains `quality-check`; engine
tests passed 60/60. Normal manager release generation can restore its release-ref stub.

Prevention evidence: the three original upload recovery/validation regressions
failed against the previous screen and passed after the fix. A separate SMTP
QUIT regression also failed against the old transport. Coverage now includes
scanner interleaving on both sides of a lost response, server-side validation and
correction, another editor's profile, unusable/missing documents, bounded retry,
shared length/calendar constraints and replacement-upload recovery. The built
browser scenario makes the real scan-result API advance the version before the
first profile PATCH; registration still finishes and persisted classification is
read back. Five production-server browser journeys passed with that interleaving.


## Duplicate-upload follow-up (2026-11-10)

| Case / identity | Authority and time | Inputs / expected outcome |
| --- | --- | --- |
| Same bytes already exist in the selected project | Server deduplication result for this POST, inside its idempotent transaction | Return the existing ID with `reused: true`; registration never PATCHes its classification, even for blank or conflicting form fields |
| Concurrent identical requests | Database unique constraint decides the creator | Exactly one creation reports `reused: false`; every losing request reports reuse and preserves the winner's metadata |
| Creation response lost | Original idempotency key and recorded response | Replay retains `reused: false` for the actual creator; version reconciliation still protects later edits |
| Older cached response lacks reuse information | No authoritative creation evidence | Preserve the stored record and direct explicit edits to its document page; do not infer creation from state, version, time or list membership |
| Replacement upload | Same server result in the selected project | Reject reused or unconfirmed creation before assigning a predecessor |
| Navigation between documents | Identity plus route pathname | Clear unfinished per-document form and upload-attempt state |

Acceptance: both base64 and multipart routes expose the same additive creation
result; duplicates never trigger a classification PATCH; fresh uploads and lost
responses retain recovery; duplicate/replay/race/route-reset regressions and a
real built-browser re-registration preserve stored type/date. No authorization,
tenant scope, unique constraint or existing metadata edit permission changes.


Manager PR #290 merged as `ca83aced` and Release Workflow run `42741098473`
completed, including the Registry service sync. The published security job was
compared with the merged source and matches the existing runner plus diagnostics.
Latest Registry main was fetched (`e0df7de`) and is already an ancestor of this
branch. The temporary workflow SHA is replaced by main's normal `@release` stub.


The duplicate regression failed in the old screen (three component cases). The
built-browser reproduction also showed a successful PATCH with null fields after
re-registering identical bytes; its trace is retained locally. The first browser
attempt used a seed/app password mismatch and was discarded; the corrected setup
reproduced the actual duplicate defect. Focused API tests passed 38/38, including
both transfer paths, an eight-request insert race on each path, original-key
creation replay, and unchanged metadata on deduplication. Focused web tests
passed 45/45 before the additional lost-upload-response cases. The separate
self-review also resets document drafts/attempts on pathname changes so a pending
replacement cannot carry into another document in the same project.
