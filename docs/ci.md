# Continuous integration

Every pull request and push to `main` runs four independent workflows:

| Workflow | Scope |
| --- | --- |
| Checks | Production dependency audit, TypeScript, web build, OpenAPI drift, brand assets, design system generated files |
| Unit tests | Package and web unit tests, design system tests, Solidity build and fuzz/invariant tests |
| Integration tests | Complete application tests with a 90% line-coverage floor, migration and restore verification, browser E2E, chain confirmation E2E |
| Security analysis | CodeQL JavaScript/TypeScript analysis and error-level finding gate |

Private CodeQL analysis uses a 2,048 MB memory budget and two threads so automatic
host resource detection does not consume the memory needed by concurrent browser
and build jobs. Its SARIF artifact is uploaded after analysis succeeds; the existing
error-level finding gate still applies.

Run `pnpm test:unit` for package/web unit tests and `DATABASE_URL=… pnpm test:integration`
for DB/API/worker tests. The fast unit workflow gives early feedback; the integration
workflow runs `pnpm test:coverage` across all application projects against PostgreSQL
to enforce the aggregate 90% line-coverage floor before merging. Its `app-coverage`
artifact includes LCOV and JSON summaries. DB tests remain serial, and CI checks
the complete run's report for skipped DB tests. `pnpm test` retains the complete local suite.

The integration workflow shares dependency installation, PostgreSQL, Foundry, and Chromium.
Browser E2E runs before the anchor worker because some browser tests assert unconfirmed
anchors. All browser tests run across four sequential Playwright shards, restarting
the API, Next.js, and Chromium between shards to release compiled-route/native caches.
The seed and demo keys stay the same across shards. It then resets the seed, starts
the worker, and runs chain confirmation E2E.
Both browser runs share the same generated demo accounts.
API and web server output and lifecycle diagnostics appear in the E2E step log.
The E2E Next.js dev server has a 1,536 MiB V8 heap budget so route compilation
collects garbage before competing with Chromium and the API for shared runner memory.
Failed browser traces, screenshots, and error contexts are retained for seven days
in the `integration-browser-failure` artifact.

PostgreSQL uses an automatically assigned host port. Containerized runners temporarily join
the service network and use its PostgreSQL DNS name; native runners use loopback. Its data lives in tmpfs, and
GitHub Actions removes the service container and network after the job. Integration logs
and PID files live in a unique directory under `RUNNER_TEMP`. An always-run cleanup step
stops the Anvil/worker process groups, detaches the runner from the service network, and
removes that directory, including on test failure.

SBOM generation is intentionally removed from PR CI as part of this simplification.
No replacement automation is included: these workflows do not generate or publish an SBOM.
Release maintainers own adding CycloneDX generation, validation, and artifact publication
to release packaging when that workflow is introduced. Until then, an SBOM needed for a
release must be produced and checked manually by the release maintainer.

## Public mirror quality signals

The public `globalmpc/globalmpc-registry` mirror uses these additional workflows:

| Workflow | Trigger | Evidence |
| --- | --- | --- |
| `public-quality.yml` | PR, main push, manual | Web/contract builds, complete Vitest coverage with PostgreSQL, Solidity coverage |
| `public-codeql.yml` | PR, main push, weekly, manual | TypeScript and GitHub Actions code-scanning results |
| `public-scorecard.yml` | Main push, weekly | Published OpenSSF Scorecard results and SARIF |

These jobs run only in the public repository on GitHub-hosted runners. The four private
workflows run only in `globalmpc-registry-private`, so copying workflows to the mirror
cannot start private self-hosted jobs there. Third-party actions in the public workflows
are pinned to full commit SHAs from stable releases, with readable version comments.
Apply dependency changes to the private source before syncing; changes made only in
the public mirror can be overwritten. Review the release and SHA together when updating.

### Mirror setup

The mirror export includes the three `.github/workflows/public-*.yml` workflows
and the root `codecov.yml`. Sync `AGENTS.md`, `docs/review-guidelines.md`, and
`docs/ci.md` together so the public working agreements retain their review and CI
references. Before publishing a sync, check that the repository-relative references
in these three documents resolve to files in the exported tree, not only in the
private source checkout. Update the exporter allowlist if it omits any of these files.
Continue syncing `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, and the full source
and test trees. The new public workflows must be committed on the mirror's `main`
branch; badges refer to that repository and its commit SHAs, not private-repository runs.
Do not copy `.github/README.md`: GitHub would show it ahead of the project README.

### Codecov setup

Sign in to Codecov with the GitHub account that administers `globalmpc`, connect the
organization, and enable only the public `globalmpc-registry` repository. Install or
approve Codecov's GitHub App if requested by the service. Uploads authenticate with
GitHub OIDC (`id-token: write` in the separate publication job), so no `CODECOV_TOKEN`
secret is needed. A main push publishes reports only after all builds and tests pass;
PR jobs retain reports as artifacts and receive no upload identity.

The `app` flag covers first-party TypeScript/TSX under `apps/*/src` and `packages/*/src`.
Untested files remain in the denominator. Declaration files, test files and dependencies
are excluded. This first report does not include Playwright browser execution or the
separate JavaScript design-system package. The `contracts` flag covers `contracts/src`;
Foundry test/script/library code and OpenZeppelin dependencies are excluded. The README labels the rendered badges `App coverage` and `Contract coverage` through
Shields.io so readers can distinguish them. Never combine those two badge values
into a project-wide coverage claim.

Vitest enforces at least 90% aggregate app line coverage for complete coverage runs.
The same full source denominator includes untested screens. `codecov.yml` enforces
an additional Codecov `app` project status with a 90% target. LCOV partial lines
count as hits, matching the build's line-coverage definition rather than requiring
every branch on an executed line to run. Branch records remain in the uploaded
LCOV report. Codecov also includes branch-only locations in its line denominator,
so its percentage can differ from Vitest's line percentage even with this setting.
It also disables carryforward: stale reports are not reused when a flag was not uploaded. Report creation and upload errors fail their respective jobs.
Build/coverage status, CodeQL execution status, and the actual alerts are separate facts;
a green CodeQL workflow badge is not a statement that the code has no vulnerabilities.

### First-run verification

After the mirror update, check that:

1. Build and coverage passes, and the coverage artifact contains both LCOV reports.
2. Codecov shows the same public commit SHA, with separate `app` and `contracts` flags.
3. CodeQL results appear under Security for both `javascript-typescript` and `actions`.
4. Scorecard's job summary confirms publication and its public result matches the mirror.
5. All README badges resolve to these actual results; GitHub image caching can delay refresh.

Review Scorecard recommendations before changing repository rules. Its score describes
this public mirror's repository practices; it does not establish the private development
repository's review or branch-protection practices. Branch rules and Codecov organization
approval may require an organization owner. SLSA provenance is deferred until a release
artifact or image publication workflow exists; no SLSA level is claimed here.

### Improving the OpenSSF Scorecard result

The public result on 2026-10-16 is **6.6/10**, for commit `0b3b38e`.
Contract coverage and CodeFactor grades do not directly increase this score.

| Check | Current score | Concrete next step |
| --- | --- | --- |
| Dependency-Update-Tool | 0 | Dependency security features are managed in GitHub settings. No scheduled version-update configuration is added by this PR; do not assume those settings alone change this check. |
| Branch-Protection | 6 | An administrator must require the public build and CodeQL checks on `main`, and review approval/bypass requirements below. |
| CI-Tests | 0 | Merge public sync PRs only after their build/test checks pass; the score examines merged PR history. |
| SAST | 7 | Keep both public CodeQL analyses successful before merging; historical coverage improves as checked PRs replace older unchecked ones. |
| Code-Review | 4 | Obtain independent approval before merging public sync PRs; this check evaluates actual review history. |
| Maintained | 0 | The mirror was created on 2026-09-14; Scorecard currently applies its less-than-90-days rule. |
| CII-Best-Practices | 0 | A maintainer must complete an evidence-backed OpenSSF Best Practices assessment; adding a badge image alone does not qualify. |

The active organization rule `main-protection` currently requires one approval,
dismisses stale approvals and requires approval of the latest push. It does not
require status checks or code-owner review. Do not edit that organization-wide rule
solely for this mirror. An administrator can add a repository-specific rule for
`globalmpc-registry/main` after confirming the exact check names on a public PR:

- Require `Build and coverage`, `Analyze javascript-typescript`, and `Analyze actions`.
  Do not require `Publish coverage`: it intentionally runs only after a main push.
- Require the branch to be up to date before merging (or use a merge queue), as well as
  PRs, stale-review dismissal, latest-push approval, and deletion/force-push restrictions.
- Require conversation resolution, and assess two independent approvals and code-owner
  review against the actual maintainer team. Configure real owners before enabling
  code-owner review, and review bypass privileges rather than assuming administrators
  are covered.

The current GitHub account has read-only access to this public repository, so these
administrator settings are not applied by the registry code PR. Verify the published
Scorecard result after synchronization. SHA pinning retains the existing dependency
protection; branch rules do not by themselves guarantee
a near-perfect aggregate score. Contributors (currently 0) measures participation
from multiple organizations. Packaging and Signed-Releases are currently unscored
(-1), because no package publication or releases are detected; address these when
real distributable artifacts and releases exist.

Scorecard references: [check definitions](https://github.com/ossf/scorecard/blob/main/docs/checks.md)
and [published result](https://scorecard.dev/viewer/?uri=github.com/globalmpc/globalmpc-registry).
