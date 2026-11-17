# CodeFactor public PR 79

Source revision: public `7e9ea134efd92d5caaa49bbdf47d68abcc5208ca`, mirrored from private main `22167865`. Three Complex Method findings: role-grant idempotency callback (19), attestationRestorationBlockers (18), PublicRecord (16).

Extract role-grant target validation, restoration evidence health query, and public record history rendering without changing outcomes, SQL, condition order, transaction boundaries, or disclosure behavior.

| Flow | Identity / authority | Frozen versus live state / scope | Priority |
| --- | --- | --- | --- |
| Role grant | Existing authenticated tenant administrator | Same withTenant/idempotency transaction; same target organization and account checks | Scope, organization and subject rejection order unchanged |
| Restore review | Existing caller and tenant transaction | Frozen evidence scope, live credential/schema/assignment/evidence checks | Same early returns and ordered, deduplicated blockers |
| Public history | Existing anonymous public projection | Retained revokedAt and version status | Revoked or superseded-with-revokedAt history stays expanded |

Acceptance: unchanged validation errors, role boundaries, restoration blockers, and public history content/visibility; each extracted function remains below the reported complexity threshold. Use existing targeted API/domain/UI tests and affected browser journeys, with no new implementation-mirroring tests. Human security review remains required for the touched authorization/review code before merge. CodeFactor cannot establish a passing grade for this private revision until it is separately analyzed; do not push to the public repository.

Self-review verified moved SQL and predicates against the original, including rejection order, tenant transaction reuse, frozen artifact/receipt handling, early returns and retained revocation display. Focused existing tests: 204 passed across admin, role revocation, verification/restoration, attestation integrity and public records. Typecheck passed. Final public-record helper extraction reran its UI suite. Local Lizard reports target functions at 9 (grant callback), 14 (restoration) and 12 (PublicRecord); new helpers at 14, 6, 4 and 4. This is local evidence, not a CodeFactor reanalysis.

Initial browser execution failed before any journey because Playwright's upgraded Chromium executable was absent. Installing the matching browser and rerunning the complete selected specs; no test or threshold changes. No new tests or dependencies added to the repository.
