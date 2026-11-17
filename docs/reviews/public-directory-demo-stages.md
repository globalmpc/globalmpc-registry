# Compact public project directory and staged demos

Keep the current header. Match the reference's compact project rows, segmented progress,
result counts, status/date and navigation affordance; retain the existing five-stage model.

| Case | Authority and time | Scope / expected result |
| --- | --- | --- |
| Directory stage | Approved published evidence snapshot | Five segments; no assessment remains unknown, never inferred from lifecycle |
| Result count | Reviews included in that public snapshot | Count evidence items with reviewed status, labelled reviewed items; no private per-project requests |
| Published / revoked | Registry version and explicit revocation | Revocation outranks published; do not rename published to live Current |
| Demo stages | Explicit develop/5611 deployment-owner seed | Add five separately identified synthetic projects; actual evaluator produces differing stages |
| Existing records | Frozen publication/history | Preserve original three scenarios, user edits, versions, hashes and signatures |
| Pagination | Public list response | Counts describe loaded projects, not an invented global total |

Acceptance: compact desktop/mobile rows; unchanged header; keyboard-accessible project links;
search/error/pagination preserved; five additive idempotent demo projects with stages 1–5;
real scan/signature/evaluator/publication paths and explicit synthetic limitations.

Each synthetic project has project-scoped demo rules using the same synthetic review. Later stages require a higher grade than that review provides. The real evaluator determines coverage; these stages do not assert real mining maturity or authorize a gate.

## Verification and review

- Focused seed/UI checks: 31 passed; additional valid frozen-summary/count regression: 17 web tests passed. Original missing-data regression remains.
- Final typecheck, OpenAPI drift check and brand checks passed. First full DB coverage run exposed a missing local `core-js-pure` installation and a missing directory version label. Installed the unchanged frozen lockfile and restored the version label and retained assertions for date, unknown-stage state and detail link; full rerun passed: 259 files, 4,159 tests, 95.88% line coverage.
- Complete public-surface and workspace-screens browser specs: final rerun 27 passed (48.4s) against the dedicated local browser DB. No header or navigation labels changed.
- Desktop 1440px and mobile 390px screenshots used actual persisted stage-seed public projections intercepted at the list transport. This isolates visual checking from API testing; seed integration tests separately establish real publication. Desktop rows measured 81–82px; mobile had no horizontal overflow.
- First browser attempt used an absent temporary filename for the database name. The owner URL therefore selected local `postgres`, where the E2E schema seed ran; the app URL selected nonexistent `mpc_app_login`. Stopped that run and repeated with the verified explicit isolated DB name. No deployed database was accessed. Pre-run contents of the local default database were not captured.
- Initial focused failures: stage claim type used a prohibited hyphen (normalized to underscore), and an over-broad test edit changed an unrelated detail-roadmap assertion (restored). Both corrected.
- Manual review: public summaries use only frozen allowlisted projection fields and add no per-row API calls. Original seed IDs remain unchanged; new IDs are scenario/tenant specific. Original fixture authority, scan/signature, tenant transactions, edit guards and append-only versions remain in place.

## Public PR 78 follow-up

The design-system sync previously deleted working outputs before running generators. It now builds a complete candidate in a temporary directory, runs both generators and writes provenance there, then replaces the destination via same-filesystem renames. Publication failure restores the original; rollback failure retains the backup with an explicit recovery path. Successful sync still removes obsolete managed files and preserves local artwork/tools. Regression checks compare all consumer files after unsupported-token and second-generator failures, plus deterministic success. The new regression fails against main’s old script because the consumer files change, and passes with the staging fix. This is an explicit offline maintainer command, not a concurrent deployment transaction or crash-proof filesystem transaction.

The full suite covers f08dfac0. The subsequent review fix distinguishes evaluated gaps with no passing stage from absent assessments and restores the publication version beside the date; final focused UI tests (38), typecheck and complete public/workspace browser rerun (27, 48.0s) passed at bcda2937. Both review threads received fix explanations and were resolved. CI and ordinary human PR review remain separate and pending. No merge or live deployment was performed.

## CI follow-up (run 43825128106)

The browser shard failed because evidence-ledger.spec.ts still expected the old directory roadmap and progressbar. This connected consumer was omitted from the earlier 27-test selection. Updated only the public-row assertions: all five accessible stage labels, Stage 1 of 5, the assessed segment, reviewed-item count and frozen-assessment boundary. Workspace/detail roadmap, publication, expiry, privacy and integrity assertions remain. Complete evidence-ledger and broken-chain specs passed locally (2 tests, 1.1m). First local invocation used the repository root instead of apps/web and exited before tests; the corrected invocation used the explicit dedicated browser DB.

The separate Checks job stopped during tsc with Killed/137 on runner label quality-check. No TypeScript diagnostics or memory counters were recorded for that job, so OOM remains a hypothesis. The browser job recorded a 5 GiB cgroup limit, 3,108,978,688-byte peak and zero OOM kills; its failure was the stale UI assertion, not a memory kill. DB, unit and security-analysis jobs passed on that CI revision.
