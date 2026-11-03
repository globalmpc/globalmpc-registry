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
| AC-10 | Supply invariant | `contracts/src/interfaces/IDeferredContracts.sol` (interface only) | Separate release |
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
| AC-27 | Key · credential recovery — a lost key or credential is disabled and replaced; past signatures and history stay. With account sessions ([`account-authentication-plan.md`](account-authentication-plan.md)), recovery also revokes every session of the subject | Disable (admin or self) ends every session of the subject: `apps/api/src/routes/admin.ts`, `core.disable_own_wallet` (`0122`, `0130`)<br>Replace by the holder (one ceremony, sessions kept, old row frozen as history), re-bind of a disabled address: `packages/db/migrations/0130_single_signing_wallet.sql`, `apps/api/src/routes/wallets.ts`<br>`packages/db/migrations/0001_schema.sql` (wallet_identities) | `api/test/admin.test.ts` ("lost key recovery (AC-27)")<br>`api/test/wallet-binding.test.ts` "disabling one's own wallet", "replacing the wallet", "why a wallet is replaced, and what it does to assurance", "re-binding a disabled address", "a compromised or admin-disabled key is never bound again", "history never changes"<br>`api/test/verification.test.ts`, `api/test/readiness.test.ts` (signatures before a replace stay attributed) |
| AC-28 | No DID · ZK dependency | Whole codebase — no DID · ZK dependency | Dependency scan (CI to be added) |
| AC-29 | Evidence channel parity | `packages/domain/src/source-result.ts` (COLLECTION_METHODS) | `domain/test/source-result.test.ts` |
| AC-30 | Material-information blackout | `packages/domain/src/disclosure.ts`<br>`packages/db` disclosure_restrictions | `domain/test/disclosure.test.ts` |
| AC-31 | R-04 prohibited-language lint | `packages/ui/src/prohibited-language.ts` | `ui/test/ui-contract.test.ts` |
| AC-32 | Natural-person identifiers blocked | `packages/domain/src/disclosure.ts` | `domain/test/disclosure.test.ts` |
| AC-33 | ERSP status ≠ legal effect | `packages/api-contract/src/common.ts` (legalEffect) | `api-contract/test/contract.test.ts` |
| AC-34 | not_evaluable blocked | `packages/domain/src/readiness.ts`<br>`packages/policy/src/engine.ts` | `domain/test/readiness.test.ts`<br>`policy/test/engine.test.ts` |

## Account authentication acceptance criteria (planned)

From [`account-authentication-plan.md`](account-authentication-plan.md) §8. Rows marked
implemented or partial name the files and tests that hold them; the rest name the test each
criterion will need, by work package.
A row moves to real file paths only when that test exists and passes.

| # | Criterion | Planned implementation | Planned tests | Status |
|---|---|---|---|---|
| AUTH-01 | An uninvited email cannot obtain a session; the response does not reveal whether it is invited | WP2 — `packages/db/migrations/0112_account_email.sql`–`0114_email_code_functions.sql`, `apps/api/src/routes/email-auth.ts`, `apps/api/src/routes/invitations.ts` | `apps/api/test/email-auth.test.ts` ("answers an address with an account and one without identically", limits, expiry, attempts, reuse, supersede, other address), `packages/db/test/account-email-migration.test.ts` | Implemented (WP2) |
| AUTH-02 | Invitation → code → second factor → "access pending" works end to end; no private data without a role binding | WP2 (invitation → code → account with no role: `apps/api/src/routes/invitations.ts`), WP3, WP6 | API (WP2): `apps/api/test/email-auth.test.ts` "invitations" (no role, single use, 72 h, revoke, cross-tenant organisation, generic audited refusal); screens (WP6): `apps/web/test/auth-screens.test.tsx` (fragment token, code, enrolment, recovery codes); E2E (WP6): `apps/web/e2e/account-auth.spec.ts` (invitation link and code from the outbox, authenticator app, sign in again; a virtual-authenticator passkey) | Implemented in the API (WP2, WP3) and the web (WP6); the E2E reads mail from `core.email_outbox` rather than Mailpit, and since WP7 the inviter signs in with an account too (`e2e/connect-as.ts`) |
| AUTH-03 | A first-factor-only session cannot read restricted data or act, except MFA and logout | WP1 — AAL derivation; WP3 | API negative tests: first-factor session refused on restricted reads and every mutation other than MFA enrolment, challenge and logout | Implemented — `apps/api/test/account-sessions.test.ts` (first-factor session view and refusals), `apps/api/test/mfa.test.ts` (MFA routes reachable from aal1; enrolment refused once a factor exists or after 24 h; a factor only through a consumed proof, also at the database) |
| AUTH-04 | Passkey-required roles are not effective in a TOTP session; step-up to a passkey makes them effective | WP3 — AAL rules per role | API: TOTP session cannot use a passkey-only role; same subject after passkey step-up can | Implemented — `apps/api/test/mfa.test.ts` "role assurance" (aal2 `mpc_operator` narrowed and refused; real passkey step-up on the same session makes it effective); web (WP6): a level refusal opens a passkey prompt and retries once (`apps/web/test/account-settings.test.tsx`, E2E `account-auth.spec.ts` step-up with a virtual passkey) |
| AUTH-05 | Google / Microsoft sign-in only for linked `(iss, sub)` / `(tid, oid)`; a matching email alone never signs in | WP4 | `apps/api/test/oidc.test.ts` against an in-process provider through `openid-client`: "never signs in, links or creates anything by email", "state, binding, PKCE and the ID token" (unknown / replayed / expired state, another browser, other provider, swapped code, nonce, audience, azp, expiry, issuer, signature), "Microsoft directories"; `packages/db/test/oidc-migration.test.ts`; E2E (WP7): `apps/web/e2e/oidc.spec.ts` against a loopback mock provider (link Google from settings and sign in with it, unlinked `sub` refused, Microsoft invitation needs `xms_edov`) | Implemented (WP4; browser E2E WP7); real Google / Microsoft apps are a staging check |
| AUTH-06 | Recovery, email change, suspension and authenticator removal revoke every session of the subject; signed history unchanged | WP1 — revoke-by-subject; WP3; suspension `packages/db/migrations/0127_subject_suspension.sql`, `apps/api/src/routes/subject-suspensions.ts` | API per trigger: all sessions of the subject return 401; attestations and gate decisions unchanged | Implemented — recovery code, authenticator removal and admin MFA reset (WP3): `apps/api/test/mfa.test.ts`; email change (WP2): `apps/api/test/email-auth.test.ts` "two-person email change"; suspension (0127): `apps/api/test/subject-suspension.test.ts` (two people, every session / factor / identity revoked, refused like an unknown account, signed history, roles and wallets unchanged, reinstatement and recovery separation), `apps/api/test/oidc.test.ts`, admin screen `apps/web/test/account-admin.test.tsx`; suspension closes open recovery and a suspended admin's proposals (0128): `apps/api/test/suspension-closes-recovery.test.ts`; suspension and MFA reset end an active break-glass elevation, and an email change ends the creation enrolment window (0129): `apps/api/test/elevation-and-creation-window.test.ts` |
| AUTH-07 | No route accepts a SIWE login; scan-worker and CRE work with service tokens; a service token cannot reach a person-only route | WP1 — service tokens; WP5 — `LEGACY_WALLET_LOGIN` off answers 404, proof-bound keys never sign in (`packages/db/migrations/0122_wallet_signing_keys.sql`); WP7 — SIWE routes deleted | API: SIWE routes absent; service token refused on person-only routes and outside its scope; scan-worker and CRE tests on service tokens | Implemented (WP7) — SIWE routes answer 404 and issue nothing, no nonce table: `apps/api/test/auth.test.ts`; live wallet sessions revoked and refused at the database, session function dropped: `packages/db/test/remove-siwe-login-migration.test.ts` (`0125`); `LEGACY_WALLET_LOGIN=1` refused at start: `apps/api/test/config.test.ts`; service tokens (WP1): `apps/api/test/service-tokens.test.ts`; a proof-bound key resolves to no subject: `apps/api/test/wallet-binding.test.ts`, `apps/api/test/admin.test.ts` (AC-27) |
| AUTH-08 | Attestation and gate-decision signatures accepted only from the right subject's **active** wallet; an account holds one active wallet at a time and changes it by replacing it (D11) | WP5 — `apps/api/src/services/signing-wallets.ts` (`assertSubjectSigner`), `apps/api/src/routes/wallets.ts`, `0122_wallet_signing_keys.sql`; one wallet per account, replace, re-bind, frozen history, pinned vote weight — `0130_single_signing_wallet.sql`, `apps/api/src/routes/governance.ts` | API: only the active wallet signs; after a replace the old key is refused and its earlier signatures stay attributed to it; unbound, disabled or other-subject wallet refused; binding signed by another key refused; replace atomic (never zero, never two, concurrent binds leave one); stale challenge refused; disabled address re-binds for the same person and a new holder, but never one compromised (directly or as a replace reason) or admin-disabled, in any tenant; a replace records its reason and lowers assurance when the replaced wallet was operator-verified; the application role cannot write a system disable reason; disabled rows never change; a replace cannot vote a snapshot proposal again (weight pinned even with no recorded wallet). DB: consolidation of multi-wallet data | Implemented (WP5, revised by `0130`) — `apps/api/test/verification.test.ts` "signing with the reviewer's active wallet, across a replace", `apps/api/test/readiness.test.ts` "signs only with the active wallet across a replace…", `apps/api/test/wallet-binding.test.ts` ("replacing the wallet", "why a wallet is replaced, and what it does to assurance", "re-binding a disabled address", "a compromised or admin-disabled key is never bound again", "history never changes"; other key, chain, subject, tenant, nonce, replay, expiry, session strength), `apps/api/test/governance.test.ts` "snapshot weight from the active wallet, across a replace", `packages/db/test/single-signing-wallet-migration.test.ts`; web: `apps/web/test/account-settings.test.tsx` (one wallet card, Replace / Disable, confirmation names the replaced wallet), `apps/web/e2e/wallet-connect.spec.ts` "the account's one signing wallet" |
| AUTH-09 | Admins cannot attach an email, identity, authenticator or wallet to another subject | WP1–WP4; WP5 — admin wallet bind removed | Email (WP2): `apps/api/test/email-auth.test.ts` "the application role cannot write an address", "two-person email change"; `packages/db/test/account-email-migration.test.ts`. Authenticators (WP3): `apps/api/test/mfa.test.ts` (the admin reset only revokes; the application role has no write on authenticators, challenges or proofs; `packages/db/test/mfa-migration.test.ts`). Identities (WP4): `apps/api/test/oidc.test.ts` "linking" (only the holder's own aal2 session links; the application role has no access to identities or login transactions, "database boundary"). Wallets (WP5): `apps/api/test/admin.test.ts` "a single operator cannot bypass the two-person rule" (route 404; the application role cannot insert, move or re-address a wallet), `apps/api/test/wallet-binding.test.ts` "history never changes" (nor re-enable a disabled one, `0130`), `packages/db/test/wallet-signing-keys-migration.test.ts` | Implemented (email WP2, authenticators WP3, identities WP4, wallets WP5) |
| AUTH-10 | The session token is not readable from page script; cross-origin mutations are refused | WP6 — `apps/web/src/proxy.ts`, `apps/web/src/lib/bff.ts` (HttpOnly `SameSite=Strict` `__Host-` cookie, `Sec-Fetch-Site` / `Origin` check, OIDC binding cookie) | `apps/web/test/bff.test.ts` (cookie attributes, token never in a body, cross-site refusal before the API, binding cookie required, no `Authorization` in client code); E2E `apps/web/e2e/account-auth.spec.ts` (cookie HttpOnly/Strict in the browser, `document.cookie` and storage hold no token, cross-site POST refused) | Implemented (WP6) |
| AUTH-11 | Full journey (account → workspace → evidence → signed review → decision → disclosure approval → publication → anchor → public proof) passes in CI with the new login | WP7 — `apps/web/e2e/connect-as.ts` (emailed code + passkey), `apps/web/e2e/seed.ts` | `apps/web/e2e/golden-path.spec.ts`, `evidence-ledger.spec.ts`, `anchor-chain.spec.ts` (Chain E2E, `E2E_CHAIN=1`) | Passes locally on account login, including the Chain E2E against a local anvil with `RegistryAnchorV1` and the anchor worker; not claimed until CI runs it |
| AUTH-12 | Threat model, acceptance map, `.env.example`, deployment and plan text are updated | WP0 | Doc review | Implemented (WP7) — threat model (T10, SIWE removal), this map, `.env.example` and `cdk/README.md` (`WEB_ORIGIN` required, SIWE variables removed), `docs/operations/deployment.md` (WP7 deploy checklist) and the plan's "WP7 as built" |

## Smart contract invariants (§13.5)

| Invariant | Status | Test |
|---|---|---|
| Registry root cannot be overwritten or deleted | Implemented | `contracts/test/RegistryAnchorInvariants.t.sol::invariant_rootNeverChanges` |
| revoked/superseded only via a new event | Implemented | `invariant_revokedBatchesRetainRoot` |
| pause does not change root or history; reads keep working | Implemented | `RegistryAnchorV1.t.sol::test_pause_blocksSubmissionButNotReads` |
| pause stops corrections (revoke/supersede); they resume after unpause | Implemented | `test_pause_blocksRevoke`<br>`test_pause_blocksSupersede`<br>`test_unpause_restoresCorrections`<br>`invariant_noRuleViolations` |
| Supersede chains have no cycles and no revoked ends at link time | Implemented | `test_supersedeBatch_refusesACycle`<br>`test_supersedeBatch_refusesARevokedTarget`<br>`test_supersedeBatch_refusesARevokedSource`<br>`invariant_supersedeWalksTerminate` |
| No privileged call can change a root | Implemented | `test_noFunctionCanMutateStoredRoot` |
| Empty batch rejected | Implemented | `invariant_noEmptyBatchStored` |
| totalSupply fixed | Interface only | Separate release |
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

- Performance targets (§13.7) — no figures while OD-32 is unresolved
- AC-28 dependency-scan CI — today there is only the fact that no such dependency exists, with no automated check

Closed since this list was written:

- Golden-path E2E — `apps/web/e2e/golden-path.spec.ts` runs registration → evidence → review
  signature → readiness → gate decision → publication → anchor batch → signed-out Explorer
  lookup and inclusion proof. It stops at "Not confirmed yet"; chain confirmation is covered by
  `anchor-chain.spec.ts` in the Chain E2E step
- Accessibility tests (§13.8) — `apps/web/e2e/accessibility.spec.ts` runs axe with WCAG 2.2 AA
  tags on the sign-in, public, workspace and administration screens
