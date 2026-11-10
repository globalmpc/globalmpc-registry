# Dependency refresh in PR 128

The user requested consolidating Dependabot PRs 129, 130 and 131 into the development demo PR.
The original seeding behavior remains the feature under review; these dependency updates share
its verification revision rather than creating parallel lockfile merges.

## Scope and compatibility

- PR 129: isolated OTel runtime auto-instrumentations 0.83.0 and SDK 0.301.0. Keep the runtime
  outside application node_modules and preserve the existing gcp-metadata override.
- PR 130: the 16 proposed minor/patch updates, including Postgres 4.1, Fastify/plugins,
  SimpleWebAuthn, OIDC, OTP, viem, S3 SDK, Next 16.4.5, Playwright 1.65 and Vite tooling.
- PR 131: jsdom 31 in both root and web. This major changes CSS/DOM behavior, async parsing and
  the optional canvas backend. No native canvas dependency is required by this application.
- Pair Vitest 5.1.0 with coverage-v8 5.1.0; the grouped bot change updated only the provider.
  Resolve the web manifest conflict without losing the other upgrades, regenerate pnpm-lock.yaml
  with pnpm 10.33.0, and verify frozen installation. Independent CDK tooling is unchanged.

| Boundary | Authority / time basis | Input scope | Expected outcome |
| --- | --- | --- | --- |
| HTTP/authentication | Existing server-side policy and current session/MFA evidence | Valid and invalid requests, passkey/TOTP/OIDC flows | Same acceptance, rejection and tenant isolation; no authentication policy edits |
| PostgreSQL | Existing tenant context, transactions and immutable histories | Real DB tests including a non-BYPASSRLS deployment owner | Same scoped reads/writes, append-only records and demo resume behavior |
| Hashes/signatures | Frozen canonical formats and stored signing scope | Existing proof corpus and synthetic demo signature | Same canonical bytes, EIP-712 recovery and public proof behavior |
| Browser/DOM | Existing user journeys and production Next build | jsdom component tests and Chromium journeys | Working sign-in, evidence, publication and anonymous lookup; preserve meaningful assertions |
| Telemetry | Explicit opt-in and protected-origin filtering | Isolated runtime, collector outage, sensitive RPC/Safe URLs, shutdown/refusal | Export ordinary requests/logs once; keep protected credentials out of telemetry and preserve process status |
| Coverage/audit | Existing complete source denominator and 90% line floor | Final dependency revision | Preserve thresholds, warning policy and existing documented advisory exception; add no new exclusions |

## Verification record

Focused checks passed before pushing the consolidated revision: frozen pnpm install, root
typecheck, 1,323 unit tests, 268 DB/API tests and four isolated OTel smoke tests. npm ci for the
OTel runtime reported no advisories. Workspace audit retained its existing documented Chainlink
zod advisory exception; no audit configuration was changed.

The first full coverage run failed four global anchor-worker assertions because earlier API
tests left nine other-chain transactions in the shared DB. The same failure was reproduced
with Postgres 4.0.0 (expected one row, observed ten), establishing test contamination rather
than a new driver behavior. The anchor-submitter suite now creates and drops its own uniquely
named database; its worker-role and traced connections use that same database. The CI PostgreSQL
owner must have CREATEDB, as its configured postgres user does. Production queries, count
assertions, schema guards and coverage thresholds are unchanged. Earlier suites' data is preserved.

Production web build, browser journeys, full PostgreSQL coverage, non-root OTel container
startup and final CI results are reported against the resulting PR head. Historical evidence
from the pre-refresh seed commit does not establish their status for this update. Independent
human security review is still required before merge because authentication libraries and the
seed's privileged deployment path are part of the change.
