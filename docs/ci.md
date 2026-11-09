# Continuous integration

This guide describes CI for `globalmpc/globalmpc-registry`. Workflow files and
package configuration are the source of truth for commands, triggers, and thresholds.
Review results for the actual commit and event rather than assuming every job runs
on every pull request.

## Workflows

| Workflow | Trigger | Evidence |
| --- | --- | --- |
| `public-quality.yml` | Pull request, push to `main`, manual | Typecheck, web and contract builds, application tests with PostgreSQL and coverage, contract coverage |
| `public-codeql.yml` | Pull request, push to `main`, weekly, manual | JavaScript/TypeScript and GitHub Actions code-scanning results |
| `public-scorecard.yml` | Push to `main`, weekly | Published OpenSSF Scorecard results and SARIF |

Pull requests run build/coverage and CodeQL analysis. Scorecard does not run on
pull requests. The `Publish coverage` job runs only after successful build/coverage
on a push to `main`; it is not a pull-request requirement. Do not treat jobs excluded
by the event as missing results.

Third-party actions are pinned to full commit SHAs with version comments. Review
the release and SHA together when updating them.

## Coverage

The build/coverage workflow runs `pnpm test:coverage` against PostgreSQL and rejects
failed or skipped tests and missing database suites. It also runs Foundry coverage.
The `coverage-reports` artifact retains application and contract reports for 14 days.

Vitest enforces at least **90% aggregate application line coverage**. The application
source denominator includes untested first-party TypeScript/TSX files under
`apps/*/src` and `packages/*/src`; declaration files, tests, and dependencies are
excluded. This report excludes Playwright browser execution and the separate
JavaScript design-system package.

Contract coverage covers `contracts/src`, excluding test, script, library, and
OpenZeppelin dependency code. Application and contract coverage are separate signals;
never combine their percentages into a project-wide coverage claim.

### Codecov publication

Pull-request and manual runs retain reports as artifacts without publishing them.
On a successful `main` push, a separate job publishes the `app` and `contracts`
reports using GitHub OIDC. Only that job receives `id-token: write`; no
`CODECOV_TOKEN` secret is needed. Report creation and upload failures fail their jobs.

`codecov.yml` sets a 90% `app` project target and disables carryforward, so a missing
flag upload does not reuse stale coverage. Partial LCOV lines count as hits; branch
records remain available. Codecov can include branch-only locations in its line
denominator, so its percentage can differ from Vitest's. Verify repository, commit
SHA, flags, and measurement time when reporting external coverage results.

## Security and quality evidence

A successful CodeQL job establishes that analysis ran, not that the code has no
vulnerabilities. Inspect actual code-scanning alerts for both `javascript-typescript`
and `actions`, alongside manual security review. Consult
[`review-guidelines.md`](review-guidelines.md) for user-journey and security review
requirements. Report pending or inaccessible analysis as unavailable evidence.

OpenSSF Scorecard describes repository practices, not application correctness or a
security certification. Inspect its published result and SARIF for the reviewed
revision. Assess recommendations against actual maintainer needs; do not weaken
checks or change repository rules solely to improve a score. No SLSA level is claimed
by these workflows.

Useful verification after a `main` push:

1. Confirm the build/coverage artifact contains both LCOV reports.
2. Confirm Codecov reports the same commit with separate `app` and `contracts` flags.
3. Inspect CodeQL results for both configured languages.
4. Confirm Scorecard publication and inspect its result for the same revision.
5. Check that README badges resolve to the relevant results; image caching can delay refresh.

## Local verification

Follow [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for environment setup and repository
invariants. Select focused checks during development, then run the applicable broader
checks before completion:

```sh
pnpm install --frozen-lockfile
pnpm test:unit
pnpm audit --audit-level high
DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm test:integration
DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm test:coverage
DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm check
```

`pnpm test:unit` includes DB-free decision tests named `*.unit.test.ts` under
`packages/db/test/` and the API contract compatibility tests. Integration mode
excludes those DB-free files; default and coverage runs include them once. These
tests check domain decisions and existing input formats. They do not establish SQL
behavior, tenant isolation, persisted hash integrity, publication correctness, or
image readiness; verify affected boundaries with the corresponding local checks
and manual review in [`review-guidelines.md`](review-guidelines.md).

For contract changes, run `forge build --sizes` and `forge test` from `contracts/`.
Use the existing Playwright configuration and fixtures for affected browser journeys.
A test run without database execution does not establish tenant isolation or
append-only guarantees. Do not parallelize destructive database suites or reset
shared seed data while tests or workers are active. Keep browser sessions and test
data isolated where concurrent work would otherwise interfere.

Production-only dependency audits exclude development tools such as Vitest and Vite.
Run the full dependency audit when investigating Dependabot alerts; a passing production
audit does not establish that development dependencies have no advisories.

Local results, CI results, and external-service results are distinct evidence.
Record their scope and revision, and report required checks that remain unverified.

### Private integration server comparison

The manager's Registry workflow separates full application coverage/migration checks from
browser/chain journeys, with one PostgreSQL service per job. Browser batches remain sequential
within their job, and the schema is reset before the anchor worker starts.

`E2E_WEB_SERVER=built` selects `next start` after `pnpm --filter @mpc/web build`;
`dev` (the local default) selects `next dev`. The manager's `e2e-web-server` input selects
the comparison mode. Include build and installation time when comparing runs, and record
runner hardware and queue time separately. A faster failing run is not an improvement.

| Boundary | Authority and required behavior |
| --- | --- |
| Browser session | Built mode uses the production `__Host-` cookie with Secure, HttpOnly and SameSite=Strict; development keeps its existing cookie. Test helpers follow that choice; the BFF policy is unchanged. |
| Mock identity provider | Only the API runs in development with the loopback OIDC relay. The built web server retains production behavior; the relay never enters a production deployment. |
| Unexpected test-server exit | The monitored launcher stops the owned Playwright batch with failure and preserves exit code/signal and memory evidence; it does not retry a broken server or skip tests to obtain success. |
| External cancellation | SIGINT/SIGTERM starts one bounded process-group shutdown deadline, preserved even when the immediate child exits. Cancellation cannot become a successful test run. |
| Final status | Failure markers are checked after recorded-server cleanup; a late marker outranks a successful CLI exit. |
| Recorded-server shutdown | The wrapper acknowledges that its requested-stop state is set before the controller signals its child group. Missing acknowledgement uses bounded fallback cleanup and fails the batch. |
| Requested teardown | The launcher forwards shutdown to its own child process group; normal Playwright teardown is recorded separately from crashes. |

Run `node --test apps/web/e2e/server-process.test.mjs` for monitor regressions. Launch browser
batches from `apps/web` with `node e2e/run-playwright.mjs [Playwright arguments]`.
`CI_TEMP_DIR` controls the diagnostics parent directory. The manager retains process artifacts
for both successful and failing browser runs; samples exclude command arguments and environment
values. Compare cgroup counters at server start and exit before attributing a failure to OOM.

Cleanup interprets Linux process state rather than PID existence alone: an acknowledged
zombie wrapper has completed, and a group containing only terminated/zombie members is
finished. A live descendant still requires cleanup even if the group leader is a zombie.
Missing acknowledgement and recorded crashes still fail the batch; zombie handling never
turns those cases into success.

The controller uses one idempotent finalization path for normal exit, spawn error,
server failure and cancellation. Test-group cleanup rejection is handled immediately;
recorded-server cleanup does not depend on a later CLI exit event. After that cleanup,
an uninterruptible CLI cannot retain the controller indefinitely: it exits unsuccessfully.
The server wrapper likewise catches cleanup rejection and records failure before releasing
its child handles. Fault-injection regressions cover both caller contracts.
