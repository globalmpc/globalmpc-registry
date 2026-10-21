# Review guidelines

## Scope and priorities

User journeys and security are joint highest priorities for every change. Review the actual code and connected behavior, not only changed lines or an implementation agent's summary. Scale review depth to impact; documentation-only changes require accuracy and consistency checks, not unrelated browser or application test runs.

Before review, identify affected actors, entry points, expected outcomes, trust boundaries, persisted state, and failure/recovery paths. Read `CONTRIBUTING.md`, relevant repository invariants, `docs/security/threat-model.md`, and applicable nested agent instructions. Keep findings grounded in code or reproduction evidence; distinguish confirmed defects from hypotheses.

## User journeys

- Trace relevant flows from UI through API, authorization, persistence/workers/contracts, and back to visible results. Check that users can finish the intended task and that displayed success matches durable state.
- Where affected, inspect role restrictions, empty/loading/error states, validation, retries, double submission, concurrency, refresh/back navigation, expiration, and recovery from partial failure.
- Check for regressions in connected consumers and existing data, including accessibility where interaction changes.
- For suspicious user-visible behavior or behavior that cannot be settled from code, open a browser and reproduce it. Record actor, initial state, steps, expected/actual results, and relevant network/console evidence. Screenshots alone do not prove persisted state or authorization.
- If the environment prevents reproduction, record the exact limitation and remaining hypothesis; do not mark the behavior passed.

## Security audit

Every change receives a security assessment proportional to its affected attack surface. Authentication, authorization, sensitive-data, and contract changes require an independent security reviewer who did not implement them.

- Verify server-side authentication, object/action authorization, tenant isolation, and least privilege. Test anonymous, wrong-role, and other-tenant requests where relevant; hidden UI controls are not authorization evidence.
- Inspect approval and lifecycle transitions, immutable/finalized records, replay/idempotency, concurrent requests, transaction boundaries, and worker privileges.
- Check input validation, injection, uploads, external requests/SSRF, session handling, and sensitive information in responses, logs, browser bundles, or artifacts as applicable.
- For contract/signature changes, inspect access control, signature/domain/chain binding, replay resistance, invariant preservation, and asset impact where relevant. Preserve canonical serialization and anchored-root reproducibility requirements.
- Supplement code analysis with direct API requests and meaningful negative tests. Use isolated test accounts/data and local chains; broader destructive or production testing requires authorization for that scope.
- Read actual static-analysis findings, not just workflow status. Automated checks do not replace manual security review. Handle vulnerability disclosure privately per `SECURITY.md`; never expose secrets in evidence.

## Efficient verification

- Parallelize independent code reviews. Forward concrete reproduction hypotheses promptly while other review continues.
- Assign one owner per shared browser session; reuse healthy servers/sessions and existing role fixtures. Isolate accounts, data, and ports when parallelism would otherwise collide.
- Reuse the existing Playwright seed/configuration and tests. Add meaningful regression coverage for behavior changes, prioritizing repeated critical journeys and security boundaries over tests that merely mirror implementation.
- Do not parallelize destructive DB suites or reset shared seed data beneath active tests/workers. Respect the existing CI ordering, worker limits, and resource budgets documented in `docs/ci.md`.
- Run focused checks first, then the required broader checks once. Repeat when fixes or new evidence justify it.

## Quality tools and evidence

Use `docs/ci.md`, workflow files, package scripts, `vitest.config.ts`, and `codecov.yml` as the maintained sources of commands and thresholds. Do not duplicate the complete CI setup here.

| Signal | Review requirement |
| --- | --- |
| CodeFactor | Examine available findings for the changed revision, including complexity, duplication, and maintainability. Preserve behavior during refactoring; keep unrelated cleanup separate. Do not invent an unconfigured grade threshold. |
| Vitest / Codecov | Preserve the configured 90% aggregate application line-coverage floor and full first-party source denominator. Inspect meaningful assertions and skipped tests. Keep app and contract coverage claims separate. |
| CodeQL | Inspect actual SARIF/alerts, including relevant warnings. The private gate fails on error-level findings; a successful analysis job does not establish absence of vulnerabilities. |
| Dependency audit | Preserve the production dependency audit at high severity and assess relevant dependency/lockfile changes. |
| Playwright / DB integration | Verify affected real journeys, server-side access boundaries, and persistence. A green run with missing DB execution is insufficient evidence. |
| Foundry | For relevant contract changes, run the configured build, tests, fuzz and invariant checks; inspect coverage where applicable. |
| OpenSSF Scorecard | Treat it as evidence about repository practices, separate from code correctness and security auditing. Do not change organization rules merely to raise a score. |
| Other required checks | Preserve typechecking, builds, OpenAPI drift, brand/design-system checks, and migration/restore checks as applicable under the existing CI requirements. |

Never improve scores by lowering thresholds, excluding production code, suppressing findings without justification, skipping failing tests, or removing meaningful assertions. A legitimate scope change or false-positive suppression needs an explicit rationale and impact assessment. Do not add arbitrary score targets.

For external results, verify repository, commit SHA, scope, and measurement time. Public mirror badges/results do not establish the status of the current private revision. Historical scores in documentation are historical evidence. If a service has not analyzed this revision or cannot be accessed, report it as pending/unavailable rather than passed. Inspect published results when publishing/synchronization is within the authorized task scope.

## Findings and completion

For each actionable finding record severity, affected journey or security boundary, code location, evidence/reproduction, impact, and expected correction. Prioritize user impact and exploitability over style. Do not present unsupported suspicions as confirmed vulnerabilities.

After corrections, inspect the new diff, reproduce the failure case again, and run relevant regression checks. Significant user defects and security vulnerabilities must be resolved and reverified before claiming completion. If blocked by missing infrastructure, accounts, or external evidence, state exactly what remains unverified and why. Report changed behavior, checks and their scope/results, and remaining issues concisely; do not claim a comprehensive independent security certification from an agent review.
