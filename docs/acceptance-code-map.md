# Acceptance criteria → code and test map

Links the product specification's acceptance criteria (AC) and requirements
(REQ-DAPP) to actual files. This document is the "traceability Code/Test columns"
item of the Definition of Done. Identifier notation: [`spec-sections.md`](spec-sections.md).

**"Not started" means the item is handled in its release.** The current scope is the
contract deliverables, so items that need an apps implementation are not closed here.

## Domain acceptance criteria

| AC | Criterion | Implementation | Tests |
|---|---|---|---|
| AC-01 | Block signing without limitations | `packages/domain/src/attestation.ts`<br>`packages/db/migrations/0001_schema.sql` (CHECK)<br>`packages/api-contract/src/resources.ts` | `domain/test/attestation.test.ts`<br>`db/test/schema.test.ts`<br>`api-contract/test/contract.test.ts` |
| AC-02 | Required gap blocks go | `packages/domain/src/readiness.ts` | `domain/test/readiness.test.ts`<br>`policy/test/engine.test.ts` |
| AC-03 | All ok is not an automatic go | `packages/domain/src/readiness.ts`<br>`packages/domain/src/machines.ts` | `domain/test/readiness.test.ts` |
| AC-04 | Revocation propagation | `packages/db/migrations/0001_schema.sql` (lineage_edges) | `db/test/schema.test.ts` (recursive CTE) |
| AC-05 | Cross-governance blocked | `packages/domain/src/governance.ts`<br>`contracts/src/interfaces/IDeferredContracts.sol` | `domain/test/governance.test.ts` |
| AC-06 | On-chain success ≠ off-chain execution | `packages/domain/src/machines.ts` (proposalMachine) | `domain/test/machines.test.ts` |
| AC-07 | Whitelist isolation | `contracts/src/interfaces/IDeferredContracts.sol` | When R6 starts |
| AC-08 | Reference pending | `packages/db` project_facts | When apps start |
| AC-09 | Integrity disclaimer | `packages/api-contract/src/resources.ts` | `api-contract/test/contract.test.ts` |
| AC-10 | Supply · vesting invariant | `contracts/src/interfaces/IDeferredContracts.sol` (interface only) | Separate release |
| AC-11 | Evaluation determinism | `packages/canonical/src/jcs.ts`<br>`packages/policy/src/engine.ts` | `canonical/test/determinism.property.test.ts`<br>`policy/test/engine.test.ts` |
| AC-12 | Credential expiry | `packages/domain/src/attestation.ts` | `domain/test/attestation.test.ts` |
| AC-13 | Source license | `packages/domain/src/disclosure.ts` | `domain/test/disclosure.test.ts` |
| AC-14 | Government take meanings kept separate | `packages/db` claims.claim_type | When apps start |
| AC-15 | Out-of-scope authority blocked | `packages/domain/src/attestation.ts` | `domain/test/attestation.test.ts` |
| AC-16 | Signature valid ≠ authority accepted | `packages/domain/src/attestation.ts` | `domain/test/attestation.test.ts` |
| AC-17 | Credential status at signing time preserved | `packages/domain/src/attestation.ts`<br>`packages/db` credential_status_snapshot | `domain/test/attestation.test.ts`<br>`db/test/schema.test.ts` |
| AC-18 | No record ≠ unavailable ≠ N/A | `packages/domain/src/source-result.ts`<br>`packages/ui/src/status-display.ts` | `domain/test/source-result.test.ts`<br>`ui/test/ui-contract.test.ts` |
| AC-19 | Schema drift | `packages/domain/src/source-result.ts`<br>`packages/domain/src/machines.ts` | `domain/test/source-result.test.ts`<br>`domain/test/machines.test.ts` |
| AC-20 | Raw/normalized mismatch | `packages/db` artifacts.kind | When apps start |
| AC-21 | Change propagation | `packages/db` lineage_edges<br>`packages/db/migrations/0045_document_impact.sql` (a replaced or expired document flags the documents resting on it and the claims verified against it)<br>`apps/api/src/routes/documents.ts` | `db/test/schema.test.ts`<br>`api/test/document-impact.test.ts`<br>`worker/test/document-expiry.test.ts` |
| AC-22 | Public/private/on-chain separation | `packages/domain/src/disclosure.ts`<br>`packages/api-contract/src/resources.ts`<br>`packages/canonical/src/leaf.ts` | `domain/test/disclosure.test.ts`<br>`api-contract/test/contract.test.ts` |
| AC-23 | Inclusion proof limitations | `packages/api-contract/src/resources.ts`<br>`packages/canonical/src/merkle.ts` | `api-contract/test/contract.test.ts`<br>`canonical/test/merkle.test.ts` |
| AC-24 | Mongolia manual operation | `packages/domain/src/source-result.ts` (collection method) | When R5 starts |
| AC-25 | Jurisdiction portability | `packages/policy/src/rule-schema.ts` (jurisdictionProfile) | When R7 starts |
| AC-26 | Three-depth consistency | `packages/ui/src/record-depth.ts`<br>`apps/web/src/app/explorer/page.tsx` | `ui/test/ui-contract.test.ts`<br>`web/e2e/golden-path.spec.ts` |
| AC-27 | Key · credential recovery | `packages/db` wallet_identities | When apps start |
| AC-28 | No DID · ZK dependency | Whole codebase — no DID · ZK dependency | Dependency scan (CI to be added) |
| AC-29 | Evidence channel parity | `packages/domain/src/source-result.ts` (COLLECTION_METHODS) | `domain/test/source-result.test.ts` |
| AC-30 | Material-information blackout | `packages/domain/src/disclosure.ts`<br>`packages/db` disclosure_restrictions | `domain/test/disclosure.test.ts` |
| AC-31 | R-04 prohibited-language lint | `packages/ui/src/prohibited-language.ts` | `ui/test/ui-contract.test.ts` |
| AC-32 | Natural-person identifiers blocked | `packages/domain/src/disclosure.ts` | `domain/test/disclosure.test.ts` |
| AC-33 | ERSP status ≠ legal effect | `packages/api-contract/src/common.ts` (legalEffect) | `api-contract/test/contract.test.ts` |
| AC-34 | not_evaluable blocked | `packages/domain/src/readiness.ts`<br>`packages/policy/src/engine.ts` | `domain/test/readiness.test.ts`<br>`policy/test/engine.test.ts` |

## Smart contract invariants (§13.5)

| Invariant | Status | Test |
|---|---|---|
| Registry root cannot be overwritten or deleted | Implemented | `contracts/test/RegistryAnchorInvariants.t.sol::invariant_rootNeverChanges` |
| revoked/superseded only via a new event | Implemented | `invariant_revokedBatchesRetainRoot` |
| pause does not change root or history | Implemented | `RegistryAnchorV1.t.sol::test_pause_blocksSubmissionOnly` |
| No privileged call can change a root | Implemented | `test_noFunctionCanMutateStoredRoot` |
| Empty batch rejected | Implemented | `invariant_noEmptyBatchStored` |
| totalSupply fixed at 10 billion | Interface only | Separate release |
| Bucket sum = total supply | Interface only | Separate release |
| TGE 13.5% | Interface only | Separate release |
| Cumulative vesting monotonically increasing | Interface only | Separate release |
| Protocol governor target allowlist | Interface only | Separate release |
| AccessRegistry ≠ ComplianceAdapter | Interface only | Separate release |

## Security acceptance criteria (§13.6)

| Item | Status | Evidence |
|---|---|---|
| Zero cross-tenant queries/mutations | Verified | `db/test/schema.test.ts` — RLS measured under the app role |
| Zero PII/secrets in public API and chain events | Verified at contract level | `api-contract` `.strict()` projection, `canonical/leaf.ts` |
| Audit cannot be deleted | Verified | `db/test/schema.test.ts` — blocked even for superuser |
| Readiness cannot be overridden | Verified | `db/test/schema.test.ts` + no API path |
| Webhook replay blocked | Not started | R2 |
| Old key blocked after key rotation | Not started | R0 apps |
| No false confirmed under RPC split/reorg | State machine only | R3 apps |

## Not yet closed in code

- Golden-path E2E (`source → ... → proof`) — needs the apps implementation
- Performance targets (§13.7) — no figures while OD-32 is unresolved
- Accessibility tests (§13.8) — when apps/web starts
- AC-28 dependency-scan CI — today there is only the fact that no such dependency exists, with no automated check
