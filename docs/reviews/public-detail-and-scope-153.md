# Public detail and scoped lookup corrections (PR 153)

| Decision | Authority / identity | Frozen versus live / input scope | Priority |
| --- | --- | --- | --- |
| Public progress | Published ledger, anonymous viewer | Green only for requirements met; remaining stages neutral | Warnings retain explicit status text, separate from progress color |
| Review list | Existing public projection | Review items, not original documents; no additional/private reads | Names/status/date first; details and limitations remain accessible |
| Public metadata | Frozen publication | Calendar dates in UTC; exact timestamps remain in time attributes and citations | Real revocation and live warnings remain visible; generic explanations collapse |
| Mutating object lookup | Effective session action scope | Reject no-scope actors before lookup; same denial for missing/out-of-scope scoped targets | Full original action authorization still required before mutation |
| Signal resolution | Same tenant and actor | Plain scope lookup, full authorization, then lock and reauthorize current row | Unauthorized actor never acquires signal row lock; changed scope fails after locking |

Security fixes address public PR 80 review comments on draft/reject/publish/revoke and stale-signal resolution. Tenant-wide authorized callers retain existing not-found/domain errors; scoped callers receive a uniform denial. No grant changes or RLS bypass. Human independent security review is required before merge.

Verification: 118 focused API/UI tests passed and typecheck passed. New security regressions failed against the original handlers and passed with the fix. The first focused run identified missing requiredRoles guidance in the new denial envelope; restored it without exposing target data and reran successfully. Desktop 1440px and mobile 390px inspected with a persisted public synthetic fixture, no page overflow. Full browser suites cover public surface, workspace screens, reference experience, ledger/broken-chain and golden path. Full coverage is run on the final stable sources after the before/after regression check; an earlier coverage attempt was deliberately stopped to avoid mixing source revisions. Independent human security review remains pending.

Duno follow-up: empty-scope denial now delegates to the existing authorization decision against a target-independent tenant resource, retaining identity-assurance and sign-in step-up guidance. Scoped missing/out-of-scope targets share the same scope-denial envelope and global access-request path. Regression asserts no target reads for insufficient identity assurance and narrowed AAL roles. Updated focused tests: 148 passed; typecheck passed. Browser suites: 33 passed. Production web build passed. Added a separate Needs review badge for watch-state directory assessments so neutral progress does not hide that warning.

## Follow-up review: CI credentials and visible limitations

Record-specific limitations and legal effect stay visible outside the publication disclosure; general explanations remain collapsed. Public-record component tests cover the disclosure boundary (17 passed).

| Case | Authority / scope | Decision |
| --- | --- | --- |
| PR code execution | Per-job GitHub token | Read-only; checkout does not persist credentials |
| Report publishing | Separate job without checkout | PR-comment write only |
| Service credentials | Explicit callable contract | Only Sonar and infrastructure-notification secrets; no arbitrary inherited secrets |
| Concurrent PR revisions | PR number | Cancel superseded revision |
| Main pushes | Run ID | Preserve each run, including pending runs |

Manager #335 restricts permissions through the shared workflow and declares named secrets. The caller pins its generated validation commit until release includes the compatible permission contract. Production deployments and test scope are unchanged. Self-hosted runner isolation and independent human security review remain platform responsibilities; this change does not claim hostile code isolation.
