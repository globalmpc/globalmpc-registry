# Repository working agreements

## Priorities and required reading

- User journeys and security are joint highest priorities. Applicable configured quality checks are additional completion criteria, never substitutes for these reviews. External scores must be reported with their revision and availability, not assumed to pass.
- Before implementation, read `CONTRIBUTING.md` and the applicable nested `AGENTS.md` files. Before reviewing changes, read and apply `docs/review-guidelines.md`.
- Use `docs/ci.md` and the actual workflow/package configuration for verification commands and scope. Preserve the repository invariants in `CONTRIBUTING.md` and `README.md`.

## Work allocation

1. Work directly as a single agent. Do not spawn sub-agents or delegate work unless the user explicitly requests agents for the task. Repository instructions, including independent-review requirements in other documents, do not authorize agent use. Do not ask to use agents merely to satisfy those requirements.
2. Define expected behavior, affected user journeys, security risks, acceptance criteria, and verification scope. For changes to state decisions, security boundaries, or historical interpretation, first record a small decision table covering identity namespaces, authority, frozen versus live state, input scope, and status priority as described in `docs/review-guidelines.md`. Ask only about material ambiguity; proceed on routine decisions. Preserve unrelated user changes.
3. Personally review the complete diff and connected flows, deriving expected outcomes and counterexamples in a separate review pass. Authentication, authorization, sensitive-data, and smart-contract changes still require an independent security reviewer who did not implement the change before merge. Use the existing human PR review process when the user has not requested agents. Until that approval is received, report independent review as pending and do not claim merge readiness. Self-review does not replace independent approval, and this requirement does not authorize spawning agents.
4. Run focused local checks, then promptly push authorized changes and open or update the PR so CI can start. Continue remaining verification while CI runs. Do not delay CI for an exhaustive local rerun when focused checks make the change reviewable. Completion still requires the verification below; do not weaken checks or thresholds.
5. Fix actionable findings directly, then review and verify the fixes and affected regressions. Do not stop at listing fixable findings.

## Verification and completion

- Apply `docs/review-guidelines.md`, including browser reproduction of suspicious user-visible behavior and direct API/negative tests for security boundaries.
- Run focused checks during implementation; before completion, perform the required checks and inspect available CI results for the reviewed revision. Clearly distinguish local results, CI results, external-service results, and unavailable evidence.
- Do not weaken checks, coverage thresholds, analysis scope, or warning policies to improve scores. Any justified exception must include its rationale and impact in the review record.
- Completion requires acceptance criteria to be met, primary-agent final review, required verification, and resolution/reverification of significant user defects and security vulnerabilities. If required evidence is unavailable, report the remaining work explicitly; do not claim verified completion.
- Final reports state changed behavior, verification results, remaining risks or unverified items, and any first-attempt failures, retries, or environment evidence affecting the conclusion. These agreements do not independently authorize pushing, publishing, merging, or messaging others; follow the user's authorized scope.

## GitHub authentication

- Before GitHub operations that read or mutate repository state (`gh`, authenticated fetch/push, PRs, checks, reviews, merges), inspect configured accounts and switch to an account with access using `gh auth switch -h github.com -u <account>`.
- Prefer switching an existing account over a new login. Request re-authentication only after switching and confirming its token is unusable.
- For `pearlify-labs` repositories, use `steven94kr` unless the user specifies another account. Never print or commit credentials.
