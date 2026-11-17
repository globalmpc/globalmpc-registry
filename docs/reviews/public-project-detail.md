# Public project detail

Match the reference's compact summary, single stage selector and expandable results while keeping Registry's header and five-stage vocabulary.

| Decision | Authority / time | Input / result |
| --- | --- | --- |
| Stage and item status | Frozen published ledger | Never turn coverage into a gate approval or infer it from lifecycle |
| Stage item links | Newly computed snapshot, subsequently approved for publication | Optional itemClaimTypes lists only claim types already in the ledger, from that stage's configured requirements; no rule/subject/document IDs, facts or raw policy definitions |
| Older publications | Original stored projection | Missing linkage is unknown, distinct from an empty known list; show all published items with an explicit notice, never rewrite hashes or versions |
| Live warnings | Existing separate live overlay | Stay visible above the frozen result; never overwrite the approved assessment |
| Record authority and limitations | Published projection | Remain visible; history/proof can be expanded without removing warnings or changing their meaning |
| Identity / access | Existing anonymous public API | No new reads, grants, private endpoints or tenant queries; existing pseudonymous reviewer fields only |

Acceptance: one five-stage selector; selectable stage filters where links exist; explicit legacy fallback; search/status filters; structured item details; accessible expandable history/proof; unchanged workspace ledger. No fabricated finding text, real reviewer names or Gate Go. New linkage is additional public metadata and needs normal independent human security review before merge.

Verify focused UI/schema/DB tests and full relevant browser files (public-surface, workspace-screens, reference-experience, evidence-ledger, broken-chain, golden-path; inspect anchor-chain consumers). Preserve all privacy, historical integrity and warning assertions. Final CI/external evidence is separate from local results.

Self-review: checked the complete diff, new/legacy/empty stage mappings, stage changes resetting filters, anonymous publication flow, frozen projection/hash preservation and the separate live warning overlay. Revoked history and negative integrity results stay expanded. No new data retrieval or grants. Human security review of the additional public stage mapping remains pending before merge.

Local evidence: initial focused suites 51 passed; relevant browser suites 33 passed (public surface, workspace, reference experience, evidence ledger, broken chain and golden path). Typecheck passed. Full application coverage passed at 95.85% lines; subsequent component extraction and negative-proof visibility change received focused UI verification. Desktop 1440px and mobile 390px checked with a persisted synthetic public snapshot; no page overflow. Preview initially timed out because Next dev blocked resources at the IP origin; retry at localhost rendered successfully. These screenshots use intercepted public responses, not deployment verification. The deployed private-network dev host was unavailable from this session. Chain-worker-specific browser run and revision-specific CI/external analysis are separate pending evidence.

## Review corrections

| Case | Authority / frozen state | Comparison / visibility |
| --- | --- | --- |
| Pending pre-upgrade assessment | Stored snapshot remains authoritative and unchanged | Omit new display links only on corresponding stages absent that field in the approved snapshot; retain policy/evidence input and outcome comparisons |
| Newly approved links | Stored links including an empty list are authoritative | Changed or missing links still fail freshness comparison |
| Revoked then superseded version | API's retained revokedAt, independent of current status | Expand history and explicitly display revocation even when status is superseded |

Added regressions for legacy frozen projection preservation, real input/outcome changes, new-link changes/removal, and superseded revocation visibility. No authorization, persistence or query changes.

Correction verification: 33 focused UI/domain tests and 16 database-backed API tests passed, including validating a separately persisted pre-upgrade snapshot through the real publication guard with the tenant-scoped runtime connection. Typecheck passed. Browser reproduction with a superseded row retaining revokedAt confirmed expanded history, visible revocation and no mobile page overflow. Rechecked the comparison callers (draft and publish share the same guard); new mappings remain strict and unknown stages are not normalized away. CI and Duno re-review are pending for the correction revision.
