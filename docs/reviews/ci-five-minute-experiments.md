# PR137 CI preparation experiments

Goal: measure a path toward five-minute CI while retaining all functional,
coverage, security and browser checks. No production release or data deletion.

Baseline application 5527b85e, run 42992779643 succeeds. Registry DB test step:
272s; browser step 209s plus chain 46s. Remote pnpm restore consumes 35–44s for
164MiB, then install takes 2s. Completion is recorded 108–113s after final runner
cleanup logs; the cause is not established. This is separate from queue time.

Experiment A uses manager PR309's generated immutable workflow commit
`a78fe7013deb0f0a5073b5651800b5ef5603fda8`, produced from source 3fe8c65.
The caller opts into pnpm-cache=off. Source tests/production code are unchanged
from baseline. All frozen installs, jobs, security settings, limits, browser
batches and coverage denominator remain. The only behavior experiment is removal
of remote pnpm restore; total setup+install must be compared, including cold work.
A metadata-only snapshot before runner teardown captures job-scoped PIDs/status/RSS
and host memory without environment contents, arguments, termination or secrets.

Manager engine tests 66/66 and generated-workflow actionlint pass. Initial boolean
input was corrected to validated remote/off strings because the generator converts
callable inputs to strings. The caller's exact test SHA is temporary and must be
returned to release after manager review/publication; it is not merge-ready while
pointing at an unreviewed experiment. Human security review of the diagnostic is
pending in manager PR309. No 5-minute or memory-saving claim is made before runs.

Experiment B preparation (not part of A's pinned application source): the successful
baseline's document-status.test.ts alone takes 19.2s and still seeds 10,000 documents,
then traverses 50 pages. This was separate from the previously reduced upload-list
suite. Reduce it to 401 documents (two full 200-item pages plus a one-item page),
retaining all 17 cases and 137 undeclared type categories. Summary expectations stay
explicit: four pending, 36 expired, 361 current. Use ten-item pages for the filtered
36-record view so filtered cursor boundaries still span four pages. Add duplicate,
terminal-cursor, partial-page and 200-status assertions rather than weakening them.
No existing records are deleted; only new fixture volume changes. Local focused
17/17 pass; the local 333ms suite duration is not compared to CI's different host.

Experiment A completed successfully: run 43131106276. DB setup-node+install fell
from 46s to 7s; the coverage step was 277s versus baseline 272s. The DB job was
452s versus 472s; the before/after difference is not entirely attributable to one
change because runner timing varies. Its final snapshot contained only its own
bash/node diagnostic processes, not retained application servers. Last runner log
was 01:03:26Z, job completion 01:05:21Z: the roughly 115s completion gap remains.
All required checks passed. No five-minute result is claimed.

A temporary read-only transport probe in this PR compares the current runner
attachment to the service network against access via the published host port.
Both create their own PostgreSQL service and execute SELECT 1 from the runner's
network namespace. No existing DB is contacted, and only the probe's attachment is
released. Its purpose is to test the network-cleanup hypothesis, not assert that
it caused the delay. It introduces no replacement for application checks and must
be removed before application merge. It is validated with actionlint; real route
availability and teardown timing are measured by GitHub, not presumed.

The 401-document preparation passes final-source typecheck, all 4,087 application
tests under coverage, OpenAPI drift and brand checks in a new isolated database.
Line coverage remains 95.81% with the full denominator and unchanged floor.

Experiment B completed: normal Quality Check run 43132385437 passed. DB job
435s (baseline 472s), browser job 492s (baseline 580s). The document-status
17-case suite fell from 19.2s to 1.176s on CI. Coverage remained 95.81%.
Different queue/host/TOTP timing prevents attributing total differences solely
to the fixture change. The separate temporary transport probe passed with the
existing service network and failed with a published-port route (connection
refused). That route is rejected and the temporary workflow is removed in C.

Experiment C removes only repeated Account-menu open/sign-out-visible/close
from the shared actor-switch helper. It retains the live authenticated subject,
AAL/recovery checks, first-login email/passkey journey and invalid-session fallback.
Production authentication and persisted data are unchanged. Real Account-menu and
sign-out assertions remain in their dedicated journeys. Complete account-auth,
oidc, wallet-connect, workspace-screens and golden-path files pass locally:
25 cases in 55.9s against built servers and a new isolated database, no retries.
C also moves the unchanged process-controller regression command to the unit lane
(manager PR309) and measures runner clock offset before interpreting teardown gaps.
Full final-source CI evidence is pending; no five-minute result is claimed.

Experiment C (46a048a5/run43134787755) passed all normal CI. All 4,087 tests
in 257 files pass; CI line coverage is 95.82% (13,754/14,353). DB job 433s,
browser 505s; coverage step 266s. Browser wall time is not a proven improvement
over B's 492s because host and authentication timing vary. Last DB log 01:35:06Z
versus completion 01:36:58Z; browser last log 01:35:35Z versus 01:37:24Z.
Clock probes report only -430ms/-364ms offsets, so clock skew does not explain
the roughly 109–112s gap. Snapshots again contain only the diagnostic bash/node,
not application servers. The remaining post-log delay is confirmed; its exact
runner-side cause remains unverified without runner diagnostics.

Experiment D keeps the same application source and opts into generated manager
8c1f72f64c1d985f0ec0dbcf7d6753442d3ae0a7. It removes only the second standalone
unit run. Vitest file discovery gives 90 unit-mode files, all present in the
257-file unfiltered default run, with no unit-specific env file/test branches.
The complete coverage command, full denominator, skipped/DB-presence gates and
all design-system, contract, controller and browser tests remain. This trades an
early duplicated unit signal for lower shared-host CPU work, not fewer cases.
Generator tests 70/70 and actionlint pass; real final-source CI is pending.

Experiment E preparation: use generated manager 1742e5f7fe5a28d5c3a957f334249d5a18840ce1
to attach the temporary DB network with gateway priority -1. Docker documents
that changing attachments can change the default gateway; a routing change could
affect existing runner/GitHub connections even though a new HEAD request works.
This remains a hypothesis. Compare actual default-route interface/gateway rows
before and after attachment, fail preparation if changed, and never print routes.
The same service DNS, own DB, existing cleanup and all test cases remain. CI's
Docker API1.54 supports the option. Generator 71/71, actionlint and manager CI
pass. Real application CI and post-log/completion timing must be measured.

D completed (d63c6a5e/run43135916268): DB 4,087/257 passes, 95.82% lines;
all browser/chain cases pass. Unit lane 191s in C → 133s in D, consistent
with removing its 65s duplicate unit run, though hosts differ. DB job 614s
and browser 662s worsened rather than improved; full coverage 427s and browser
346s indicate substantial execution variance, not just final reporting delay.
Final snapshots show approximately 3GiB MemAvailable; DB SwapFree only20MiB.
The overall run FAILS: JS CodeQL extraction was killed with137 and cgroup
oom_kill increased to1. This is confirmed memory pressure, not a code finding
or completed analysis. No blanket CI success or five-minute claim is made.
Both integration jobs still show approximately110s post-log gaps with near-zero
clock offsets. E will rerun all checks, including the failed security analysis.

E first attempt (23a4178f/run43137522430): actual default-route invariant passes.
All 131 browser/chain cases pass without flaky retries. Normal browser last log
02:02:13.632Z → completed02:02:22Z: approximately8s, versus C109s/D107s.
The DB setup failed before tests when frozen pnpm install was killed137; its
last log01:55:03Z → completed01:55:14Z also approximately11s. The gateway
change has removed the previously observed integration completion gap in these
measurements. Browser overall515s remains above5min due to test/preparation
time and host variance; no target-achievement claim is made. First attempt
also killed Checks pnpm install and JS CodeQL query evaluation137. DB cgroup
oom_kill1 and SwapFree≈1MiB confirm memory pressure; no checks are suppressed.
Only the three failed jobs are being rerun, leaving successful browser evidence.

Detailed D-log review additionally found two browser cases passing only on retry,
not first attempt: access-pending invitation and account-auth invitation. Both
read the Organisation control's tag while listOrganizations was loading, then
called fill after React replaced the text input with a select. These explain
part of D's added browser runtime; a blanket no-retry claim would be incorrect.

Final follow-up F changes the three affected invitation consumers (access-pending,
account-auth, oidc) to wait on the accessible Organisation combobox, select the
seeded organisation and assert the selected value. That fixture organisation is
required; a failed organisation load should fail rather than take a transient
fallback branch. Production controls, auth/session checks, cases, retries and
timeouts are unchanged. Existing D failures are before-fix reproduction evidence.
All three complete files pass locally in built mode against a new isolated DB:
6/6 in46.7s with --retries0. Web typecheck and diff checks pass. Full final-source
CI remains required; no preexisting DB is changed or deleted.

E rerun attempt2 completed successfully; all required checks now pass at23a4178f.
The two inspected CodeQL SARIF outputs contain zero results. Failed first-attempt
CodeQL/Checks/DB-install jobs are retained above rather than represented as first-
attempt success. The successful DB retry job was367s, still above five minutes.
The normal browser job was515s; queue and host variance remain material.
F's final-source full CI will verify the invitation-race correction as well.

Published workflow follow-up: manager PR309 merged as b9e7730f and its release
workflow generated release commit 7f019a8c. The published Registry workflow has
the non-fatal diagnostic fix, gateway preservation and removal of duplicate unit
execution. Restore the application caller to @release, removing the experimental
SHA pin. Retain the already-tested pnpm-cache:off input so this run changes the
workflow source rather than the cache comparison mode. Local caller actionlint
and published-workflow contract checks pass; new-revision full CI is pending.
Host memory/resource configuration is unchanged by this reference update.
