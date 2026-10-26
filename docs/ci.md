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

Local results, CI results, and external-service results are distinct evidence.
Record their scope and revision, and report required checks that remain unverified.
