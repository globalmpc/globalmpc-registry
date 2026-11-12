# Threat model — MPC dApp

> **Written:** 2026-09-09 · R0 exit criteria ("threat model")
> **Scope:** what this repository deploys — the monorepo (api · web · worker · contracts) and
> what it depends on: PostgreSQL · S3-compatible object storage · BNB Chain · ClamAV.
> **Out of scope:** the data-analysis axis kept in a separate repository (OD-37), and the R6
> transaction path that does not exist yet (OD-07).

This document **does not pass judgment.** It records what is being defended against whom, what is
blocked, and what is not blocked yet. What is not blocked is not hidden; it is left with a name —
the use of a threat model is not the length of the list but **making what is missing recognizable.**

## 1. What is protected

In priority order. Further down, losses become recoverable.

| # | Asset | What collapses if lost | Recoverable |
|---|---|---|---|
| A1 | **Anchor signer private key** | Arbitrary roots can be put on chain in our name. What is already on chain cannot be undone | No (past submissions remain even after key rotation) |
| A2 | **Irreversibility of what has been published** | A fact once published is not withdrawn (spec 05 §5.7) | No |
| A3 | **Original evidence** (contracts, possibly personal data) | Jurisdiction and personal-data violations. OD-17 and OD-18 unresolved | No |
| A4 | **Integrity of the audit record** | "Who did what" cannot be answered. There is no audit | No (append-only) |
| A5 | **Accuracy of registry content** | Wrong facts are published and anchored | Partial (marked by correction or withdrawal) |
| A6 | **Availability** | Queries stop | Yes |

**A1 and A2 come before the rest.** The rest can be repaired; these two cannot.

## 2. Trust boundaries

```
          [ internet · anonymous ]
                 │
     ┌───────────▼───────────┐   boundary 1: unauthenticated public surface
     │  /api/v1/public/*     │   calls SECURITY DEFINER functions only
     │  9 Explorer pages     │   no session. The only path that bypasses RLS
     └───────────┬───────────┘
                 │
         [ holds an account session ]
                 │
     ┌───────────▼───────────┐   boundary 2: role and action permissions
     │  /api/v1/* (the rest) │   the 7 ACTION_POLICIES conditions + RLS
     │  Workspace pages      │   tenant and project scope diverge here
     └───────────┬───────────┘
                 │
     ┌───────────▼───────────┐   boundary 3: system identity
     │  worker (anchor · scan │   non-human principal. Holds private keys and
     │  · outbox)            │   signing authority
     └───────────┬───────────┘
                 │
   ┌─────────────┼─────────────┬──────────────┐
   ▼             ▼             ▼              ▼
PostgreSQL   object store   BNB Chain     notification sinks
(RLS)        (uploaded      (public ·     (external HTTP)
              originals)     permanent)
```

Boundary 2 is drawn as planned in [`../account-authentication-plan.md`](../account-authentication-plan.md):
an invitation-only account session keyed by subject, with wallets kept only as signing keys.
WP1 (account core) is implemented: sessions are keyed by subject and carry an AAL derived from
their factors, and workers use service tokens; WP2–WP5 (email code, second factors, Google /
Microsoft, wallets as signing keys) are implemented in the API, and the web signs in with them
(WP6): the browser's session token is an HttpOnly cookie the web proxy turns into the API's bearer,
never visible to page script. WP7 removed the wallet (SIWE) sign-in: no route issues a session for
a wallet signature, and migration 0125 revoked any such session left and forbids new ones. T10
lists the threats the change introduces and which controls are in the code.

**Boundary 1 is the most dangerous.** There is no session, so RLS tenant isolation does not
apply, and what the `SECURITY DEFINER` functions return is the public scope. The `WHERE` clauses
of those functions are the entire public boundary.

## 3. Threats

Divided by `STRIDE`, but **only those that actually apply to this system** are listed.

### T1 · Anchor signer key theft (Elevation / Tampering) — A1

**How it happens:** worker container environment exposure · access to the deployment platform ·
log leakage.

**Blocked now**

- The spend cap `ANCHOR_DAILY_SPEND_CAP_WEI` (no default; startup refuses it unset) gates worker
  sends against actual receipts and open reservations. Gas has a signed ceiling; on opBNB the
  L1 data-fee reservation is twice a live quote and is not an enforceable fee ceiling.
- The gas cap `ANCHOR_FEE_CAP_GWEI`. Blocks submissions at abnormal prices.
- The retry cap `ANCHOR_MAX_ATTEMPTS`.
- Real credentials are supplied at runtime and must not be committed. The local Compose stack
  injects environment values directly, with explicitly public demo defaults; these values are
  visible in the container environment and `docker inspect`. Application configuration also
  supports `file:` and `env:` references when the deployment uses them.
- `pause` contains a stolen submitter key: it stops `submitRoot` **and** the permanent
  corrections `revokeBatch` / `supersedeBatch`. Reads and proof verification keep working.
  Recovery order: the admin rotates `ANCHOR_SUBMITTER_ROLE`, the pauser unpauses, then the new
  key corrects.
- Supersede links cannot form cycles or point at withdrawn roots: the successor must exist, must
  not be revoked and must be the head of its chain, and a revoked batch cannot be superseded.
- The admin role (`AccessControlDefaultAdminRules`) has one holder and moves only in two steps,
  accepted after `ANCHOR_ADMIN_DELAY_SECONDS`; renouncing uses the same delayed flow. The deploy
  script bounds the delay per chain: at least 300 s on 5611 and 1 day on Safe chains, at most
  30 days off 31337 (a milliseconds typo would otherwise lock handovers for years). A stolen admin key cannot take the role at once, and the
  current admin can cancel within the delay.
- An EOA may hold the submitter role only on 31337 and opBNB testnet (5611). Elsewhere the deploy
  script requires a contract (the Safe), and the worker submits directly only on chains in
  `ANCHOR_EOA_CHAIN_IDS` (31337 by default, 5611 by opt-in, nothing else accepted); on other
  chains it proposes to the Safe.
- Shared-chain key checks reject the known committed signing fixtures from configuration and
  test sources as well as the standard anvil accounts. The fixture audit recognizes supported
  literal declarations; it cannot identify every key that could be derived from public data.

**Not blocked yet**

- Before the pauser reacts, a stolen submitter key can still revoke or supersede batches, and
  those marks are permanent. The roots themselves stay unchanged.
- The funding cap **cannot be enforced by code.** Holding only one day's worth in the wallet is a
  finance and operations procedure (`docs/operations/deployment.md`, "Loss cap for the anchor wallet").
- On opBNB, the L1 fee can rise beyond its reservation before inclusion, so actual daily spend
  can exceed `ANCHOR_DAILY_SPEND_CAP_WEI`. Keep the funded wallet within the intended loss budget,
  disable automatic refills and reconcile receipts and open sends before replenishing. A stolen
  key can spend the funded balance directly, bypassing every worker admission check.
- The key rotation procedure exists only as a document; there is no drill record.

### T2 · Public boundary leak (Information Disclosure) — A2 · A3

**How it happens:** a `SECURITY DEFINER` function returns a column that was not meant to be
public · bypass of the projection allowlist · internal identifiers in error messages.

**Blocked now**

- Public projections are stored only after passing a `.strict()` Zod schema. An undefined field
  mixed in is a 422 (AC-22).
- The public history carries **only "it happened + when + which record."** It carries neither
  content nor parties, and a test checks that boundary at the string level
  (`apps/api/test/public-governance.test.ts`).
- Events of unpublished projects do not go out — if they did, the **existence itself** of a
  private project would be revealed.
- Uploads with sensitive classifications (`confidential`, `pii`, `whistleblower`) are rejected
  with 422 (OD-18).
- The inclusion proof carries only the format version, not the subject.

**Not blocked yet**

- **Credential revocation is not published** — its "record" is a person, which the current rules
  cannot express. If a decision is needed, raise a new open item.
- With OD-17 and OD-18 unresolved, the jurisdiction in which originals reside is not settled.
  **This is what blocks the production deployment.**

### T3 · Tenant boundary bypass (Elevation) — A3 · A5

**How it happens:** a query that trusts the session's tenant · a path without RLS · careless use
of `SECURITY DEFINER` functions.

**Blocked now**

- RLS + `FORCE ROW LEVEL SECURITY` on every tenant-owned table. The application role sees only
  through `core.current_tenant()`.
- Authorization is decided by 7 conditions (`ACTION_POLICIES`) — role, assurance, tenant, project,
  sensitivity, state, conflict of interest. Refusal reasons are returned distinctly.
- Two-person rule: proposer ≠ approver.
- Suspension is done by one person, but **the person who suspended cannot reinstate** (migration 0031).

**Not blocked yet**

- `SECURITY DEFINER` functions bypass RLS by design. Adding a new function requires judging the
  public boundary again, and no check enforces that. → **follow-up candidate**

### T4 · Malicious upload (Tampering) — A3 · A6

**How it happens:** a malicious file is uploaded and another user downloads it · the scanner is
not running.

**Blocked now**

- Uploads enter as `quarantined` and are `promote`d only from `scanned_clean`. Only the
  `scan_service` role can write scan results.
- ClamAV runs in a separate container without worker credentials, application files or
  shared worker mounts. Only the scan worker joins its internal scan network; no scanner
  port is published. Signature-update egress uses a separate network from the application.
- A scanner failure leaves files quarantined; only a successful clean result permits promotion.
- Worker liveness is recorded in `core.worker_heartbeats`; ClamAV has an independent daemon
  health check. A live worker heartbeat alone does not prove scanner availability. Monitor
  both container health and exhausted scan retries.

**Not blocked yet**

- Whether the scan worker is actually running in the deployed stack **cannot be known from
  inside the repository.**
- Container isolation still depends on the host kernel and runtime. Scanner compromise can
  affect scan verdicts or availability; the container boundary does not establish that every
  malicious file is detected. Signature updates require outbound connectivity, so scanner
  compromise can also expose the document bytes it processes.
- ClamAV spools streamed uploads to the disk-backed `clamavscratch` volume at
  `/var/tmp/clamav`, separate from signature storage in `clamavdata`. The image creates the
  scratch directory owned by the scanner user with mode `0700`; the parent filesystem stays
  read-only.
  Quarantined document bytes may remain there after a crash. For the local demo, stop
  ClamAV before removing its scratch volume. Production storage residency and retention
  still require the decisions tracked by OD-17 and OD-18; this mount does not resolve them.

### Scanner isolation decision table

| Case / identity | Authority and state | Input scope | Result / priority |
| --- | --- | --- | --- |
| Uploaded bytes reach ClamAV | Scanner process; live untrusted parsing | INSTREAM bytes only; scanner signature/scratch volumes | No worker secrets, app files or application-network membership |
| Worker reports a verdict | Existing scan-service identity and authorization | Matching quarantined document and successful scanner response | Clean result is required for promotion |
| Scanner unavailable before accepting bytes | Live scanner PING; worker owns any acquired lease | Unreachable daemon before lease, or a connection failure before INSTREAM | Keep quarantine and preserve upload attempt budget; pause until recovery |
| Scanner accepts a file but cannot complete it | Live bounded response; file can trigger parser failure | Timeout, reset, malformed or oversized verdict after connection | Keep quarantine and count a bounded attempt, preventing one file from retrying indefinitely |
| Published evidence and Registry state | Existing approval and immutable hash rules | No change to frozen evidence, tenant authority or CRE reports | Container changes confer no new approval authority |

### T5 · Public API abuse (Denial of Service) — A6

**How it happens:** bulk requests to unauthenticated paths · repeated expensive queries.

**Blocked now**

- Keyset (cursor) pagination. No OFFSET, so deep pages do not get expensive. The server clamps
  `limit` to 1–100.
- Application-level rate limit and request size / timeout policy.
- `cache-control: public, max-age=30`.

**Not blocked yet**

- **The application rate limit is process-local.** As replicas grow, so does the total allowance.
  A shared store or an edge limit is needed, and that is platform configuration.
- Whether 429-rate and sign-in-failure-rate (`MpcSignInFailureRate`) alerts are actually wired in
  the observability stack is unconfirmed.

### T6 · Audit record forgery or deletion (Repudiation) — A4

**Blocked now**

- `audit.events` is append-only. Every mutation is recorded, including the effective role.
- State transitions have history tables (`governance_transitions`,
  `project_lifecycle_transitions`) — from the current state alone, "quorum not reached" and
  "cancelled" cannot be told apart.
- History is **written explicitly by the route.** Not by triggers — a trigger does not know "who
  or why," and pushing that in through a session GUC lets a path that forgot to set it be quietly
  recorded as "the system did it."

**Not blocked yet**

- The DB superuser can still do anything. There is no external append-only copy. The anchor plays
  that role **only for the public registry.**

### T7 · Leak or forgery through notification sinks (Spoofing / Disclosure)

**Blocked now**

- The webhook body is signed with HMAC-SHA256 (`${timestamp}.${body}`) — the sink can verify the
  sender, and the timestamp narrows replay.
- If the secret cannot be resolved, the delivery is **immediately `failed`.** Nothing is sent
  unsigned.
- Exponential backoff and an attempt cap.

**Not blocked yet**

- The sink URL itself is chosen by the registrant. Destination restriction from an SSRF
  standpoint depends on the deployment environment's egress policy. → **follow-up candidate**

### T8 · Chain reorganization (Tampering) — A5

**Blocked now**

- `included` is not success. Only `confirmed` is success (spec 06 §6.8).
- `chain.reorg_events` and the reconciliation worker.
- `ANCHOR_CONFIRMATIONS` uses **the same value on staging as in production** — otherwise reorg
  handling is not verified.
- Depth is a block count, not time (12 blocks are 3 s on opBNB), so on shared chains a receipt's
  block must also be at or below the node's `safe` head (`ANCHOR_FINALITY_TAG`) before `confirmed`.

### T9 · Supply chain (Tampering)

**Blocked now**

- CI checks dependencies and the SBOM. `design-system/dist/` is a committed artifact, so the
  build-time injection surface is narrower by that much.

**Not blocked yet**

- There is no container image signing and verification procedure. → **follow-up candidate**

### T10 · Account authentication (Spoofing / Elevation / Disclosure) — A3 · A4 · A5

**Status: WP1–WP7 and suspension (AUTH-06) implemented.** The controls below come from
[`../account-authentication-plan.md`](../account-authentication-plan.md) §5. Listing them before
they exist means each change is reviewed against a fixed target rather than its own rationale.

- **Implemented (WP1):** subject sessions (`core.sessions` keyed by subject and tenant, minted and
  revoked only inside the subject's tenant context, absolute TTL 8 h, idle timeout 30 min, purged
  by the jobs worker); AAL derived from the recorded factors, never admin-set; the MFA-bypass
  priority rules (a first-factor session reaches only its own session view, without roles or
  actions, plus logout; a role whose AAL or identity-assurance minimum is not met is narrowed
  out); wallet disable revokes every session of the subject; service tokens (opaque, hashed,
  service subject, route-scoped, expiring, CLI rotation with bounded overlap, never a person
  role). Tests: `apps/api/test/account-sessions.test.ts`, `apps/api/test/service-tokens.test.ts`,
  `packages/db/test/subject-sessions-migration.test.ts`, `apps/jobs-worker/test/auth-purge.test.ts`.
- **Implemented (WP2):** email-code sign-in (8 random digits, stored only as an HMAC under an
  HKDF key the database never sees, compared in constant time, 10-minute TTL, 5 tries per code,
  single use, bound to its purpose and address, a new code supersedes the old one); per-address
  and per-IP limits in the database (IPv6 counted by /64); identical response and a 250 ms floor
  for an address with and without an account (decoy challenge, no mail); an `email_code` session
  only through a challenge consumed in the same transaction (trigger + CHECK; the general session
  function refuses it), at `aal1`; invitations (random token hashed, link token in the URL
  fragment, 72 h, single use, revocable, no roles, new subject at `wallet_only`, the code goes to
  the invited address, one generic audited refusal for an address in use); two-person email
  change (proposer ≠ decider ≠ person, code to the new address, all sessions revoked, old address
  notified); the application role cannot write `core.subjects.email` or read challenges, mail or
  rate events; audit detail holds a keyed hash of an address, never the address; mail is sent by
  the jobs worker only (Resend in production; the key is never given to the API), and a queued
  code is cleared once the mail settles. Tests: `apps/api/test/email-auth.test.ts`,
  `apps/api/test/account-crypto.test.ts`, `apps/api/test/bootstrap.test.ts`,
  `packages/db/test/account-email-migration.test.ts`, `apps/jobs-worker/test/email.test.ts`.
- **Implemented (WP3):** second factors. Passkeys (WebAuthn, user verification required, RP ID
  and origin from `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN`, challenges single use, bound to the
  session that asked, 5 minutes) and TOTP (secret AES-256-GCM sealed under a key derived from
  `SESSION_SECRET`, ±1 step, a step never accepted twice, 5 attempts per 15 minutes counted before
  the check). `core.create_subject_session` no longer records a second factor; a session gains one
  only through a proof row that consumed a live challenge, a TOTP step or a recovery code, and a
  CHECK plus composite foreign key refuse a factor without its own proof even to the table owner.
  The database cannot check a signature or a code: the API verifies them, and the functions the
  API role calls guarantee single use, binding to the session that asked and the enrolment
  rules — a compromised API process could still raise its own sessions (accepted, as for every
  other API-held authority).
  First enrolment from a first-factor session only within 24 h of account creation or of an
  approved reset and never once a factor exists; a second passkey needs a passkey session;
  removal needs the strongest factor held, revokes every other session and never removes the
  last factor; a revoked authenticator ends the sessions it proved. Regenerating recovery codes
  needs the strongest factor held (a fresh code can enrol a passkey). Recovery codes (10 × 80 bit,
  SHA-256, single use) end every other session and leave the recovering session limited to
  re-enrolment and logout; proving a factor from it completes the recovery and ends every
  session of the subject, the recovering one included (plan journey 5). Admin MFA reset is two-person (neither the person reset), revokes every
  authenticator and session of the person, and opens a 24 h enrolment window. Tests:
  `apps/api/test/mfa.test.ts`, `packages/db/test/mfa-migration.test.ts`.
- **Implemented (security review of WP2 + WP3, migration 0118):**
  - *Recovery separation.* Email change and admin MFA reset are each two-person, but chained (two
    admins move the address to a mailbox they read, then reset the factors, then enrol their own
    passkey from an aal1 email-code session) they were a takeover. Whoever proposed or decided an
    email change of a person (pending, approved or completed, last 30 days) can neither propose
    nor approve an MFA reset of that person, and whoever proposed or decided a pending or approved
    reset (last 30 days) can neither propose nor approve an email change of that person; a
    rejection is always allowed. Enforced in the database (insert trigger on
    `core.mfa_reset_requests`, `core.decide_mfa_reset`, `core.request_email_change`,
    `core.decide_email_change`, each locking the subject row first) and answered as
    `ACCOUNT_RECOVERY_SEPARATION_REQUIRED`. The chain therefore needs four colluding admins.
  - *Reset notice.* An approved reset mails `mfa_reset_notice` (no code, no link) to the current
    address and to every address the account was moved away from in the last **90** days —
    longer than the 30-day separation, so a reset by the same pair just after it lapses still
    reaches the owner (0119). The previous address is kept on the completed change for those 90
    days only, and the application role cannot read it (column-level SELECT, 0119).
  - *Email change needs an address.* A person without one cannot be given one by an email change
    (`EMAIL_CHANGE_NO_ADDRESS`); a first address comes only from accepting an invitation.
  - *Creation time.* The first-enrolment window runs from `subjects.created_at`; the application
    role can no longer write it, and no row may claim a creation more than five minutes ahead.
  - *Bootstrap enrolment window.* A bootstrap re-run opens a 24 h first-enrolment window for an
    existing person who holds no passkey or TOTP (the first operator has no second admin for a
    reset); it opens nothing once a factor exists. A reset window that no longer counts — closed
    by its approver's suspension, or ended by a later suspension or address change — does not
    stop it (0133, L1). Audited as `deploy_bound`.
  - *Lock order.* Every function that changes how a person signs in or recovers locks the
    person's subject row first — the MFA functions before the session; the MFA-reset, email-change
    and suspension decisions and the email-change completion before the request, its challenge and
    the sessions (0132, F3; before it the decisions locked the request first and a suspension could
    deadlock with them) — so two calls about one person serialize instead of deadlocking. A
    suspension also closes rows of other people it names (what they proposed or approved); it
    takes those after its own subject lock and never a second subject lock. A Google /
    Microsoft sign-in takes `FOR KEY SHARE` on the identity's person before it locks the identity
    (0133, N1; before it, a sign-in holding the identity and a reset holding the person could
    deadlock). Tests: `apps/api/test/account-state-races.test.ts` ("F3", "0133"). A deadlock or
    serialization abort that still happens anywhere answers 409 `CONCURRENT_REQUEST`, retryable.
    *Accepted:* two decisions in which each admin is the other's subject (A decides about B while
    B decides about A) each hold their subject `FOR UPDATE` and then take the other's
    `FOR KEY SHARE` through the actor foreign key, so one of them can abort with 40P01 and is
    retried; it was so before 0133 as well.

  Tests: `apps/api/test/mfa.test.ts` ("recovery separation (0118)", "subject creation time"),
  `apps/api/test/bootstrap.test.ts`, `apps/api/test/email-auth.test.ts`,
  `apps/api/test/error-handler.test.ts`, `apps/api/test/observability.test.ts`,
  `apps/jobs-worker/test/email.test.ts`.
- **Implemented (WP4):** Google / Microsoft sign-in by authorization code + PKCE S256 with
  `state`, `nonce` and a browser binding (login CSRF), all stored as hashes; the PKCE verifier
  and nonce sealed under an HKDF key and deleted at the claim; ID token signature checked
  against the provider's keys, `iss`, `aud`, `azp`, expiry and nonce; Microsoft on the
  `organizations` endpoint, `iss` bound to the token's own `tid`, personal accounts and
  directories outside `MICROSOFT_ALLOWED_TENANTS` refused; identities matched only by
  `(iss, sub)` / `(tid, oid)`, never by email; linking and unlinking from an aal2 session only,
  one generic code for an identity linked anywhere, never the last way in; invitation acceptance
  only for a provider-verified invited address — for Google only a Gmail address or one in the
  token's `hd` Workspace domain, otherwise `OIDC_EMAIL_CODE_REQUIRED` (security review L7);
  recovery — an approved MFA reset or a completed email change — revokes sessions, second
  factors **and linked identities** of the subject in the same transaction, and the notice names
  the removed providers (security review M3, 0123); a provider session only through a transaction
  completed in the same database transaction (CHECK + trigger), at `aal1`; a sign-in finds and
  locks its identity in one statement, so one racing a reset, an address change or an unlink waits
  for it and then finds the identity revoked, and a provider session stops resolving once its
  identity is revoked (0132, F1; `apps/api/test/account-state-races.test.ts`); provider error text
  never echoed. Tests: `apps/api/test/oidc.test.ts` (against an in-process provider through the
  real library), `packages/db/test/oidc-migration.test.ts`, `apps/api/test/config.test.ts`,
  `apps/jobs-worker/test/auth-purge.test.ts`.
- **Implemented (WP5, migration 0122):** wallets are signing keys, bound only by their holder.
  - *Binding by proof.* A person binds a key to their own account by signing an EIP-712
    `WalletBinding` (purpose, tenant, subject, address, chain, nonce, issued/expires; domain
    "MPC Wallet Binding" with the chain id and a fixed salt) from an account session at the level
    of the strongest factor they hold (aal3 once a passkey exists, else aal2), never
    recovery-limited and never a legacy wallet session. The challenge is per session, single use,
    5 minutes, replaced by the next request; the API rebuilds the signed message from the
    challenge row only, and the database consumes the challenge and inserts the wallet in one
    function (`core.bind_wallet_by_proof`). An address bound anywhere — this account, another
    subject, another tenant, an operator-bound key — answers one generic `WALLET_UNAVAILABLE`.
    EOA signatures only (no EIP-1271).
  - *No admin attach.* The admin bind route is removed (404), and the application role has no
    INSERT or UPDATE on `core.wallet_identities` beyond `disabled_at` / `version` (and since
    0130 a trigger stops even that from re-enabling a disabled row). Identity assurance is set on the person by another admin with a recorded
    justification (`POST /api/v1/admin/subjects/{id}/assurance`, audited
    `admin.subject.assurance_set`, never for oneself or a service). A proof binds the key at
    `wallet_only` and never raises the person's assurance.
  - *A key signs, it never signs in.* There is no wallet sign-in (WP7): the SIWE routes, their
    nonce table and the database function that created wallet sessions are gone (0125), and a
    session whose first factor is a wallet cannot be inserted. So a TOTP session cannot bind a key
    and then sign in through it at `aal3`.
  - *Signers.* Attestation signatures and gate decisions accept only the active wallet of the
    assigned reviewer / the approver on the deployment's chain, and record the recovered address
    as the signer and audit `actor_wallet`; a draft names no signer (zero address) until it is
    signed.
- **Implemented (0130): one active wallet per account, changed by replacing it** (plan D11).
  - *1:1.* Partial unique indexes keep one active row per address and chain, and one per subject;
    concurrent binds serialize on the subject lock and the index backstops any other writer. A
    disabled address can be bound again — by the same person or a new holder — only through the
    proof ceremony, as a new row audited with `rebindOf`; disabled rows never change (trigger), so
    attestations, gate decisions and audit rows signed before keep naming the wallet row and
    subject that signed.
  - *Replace.* Binding while holding a wallet replaces it in one transaction (old row disabled
    `replaced`, new row inserted): never zero, never two. The challenge names the wallet it
    replaces, so the screen shows it before the wallet opens, and is refused as stale if the
    account's wallet changed meanwhile. Needs the strongest factor held. Sessions are kept: the
    old key stops signing in the same transaction and no session rests on a wallet. A disable
    without replacement still ends every session (AC-27).
  - *Governance (D9).* The active wallet is the governance wallet; there is no designation. A
    snapshot vote records and pins its weight wallet and weight (trigger, unique per proposal),
    so replacing a wallet cannot vote the same proposal again with another balance, and a new
    holder of a wallet that already voted is refused (`GOVERNANCE_WALLET_ALREADY_VOTED`).
  - *Compromised keys stay out.* A key ever disabled as `key_compromised` (directly or as the
    cause of a replace) or disabled by an admin is never bound again, by anyone, the same person
    included — the history is read across tenants, and the refusal is the same
    `WALLET_UNAVAILABLE` as an address active elsewhere. A lost key (directly or as a replace
    cause), a consolidated wallet and a disabled row with no event come back only to their own
    subject; only `rotation` / `offboarding` keys pass to another holder. NULL subjects and
    deciders refuse. The bind reads the history with `row_security = off`, so an owner that does
    not bypass RLS errors rather than narrowing the check to the current tenant. The bind is not
    the only such reader: every definer function that reads across tenants (sign-in, address and
    identity uniqueness, session and service-token lookups, purges, the vote pin) gets the same setting in `0131`, and
    `packages/db/test/cross-tenant-definers.test.ts` requires every definer to be classified. A replace records why
    (`replace_cause`). Replacing an operator-verified wallet lowers assurance to `wallet_only`, as
    its disable does.
  - *Residual.* The application role still inserts `wallet_disable_events` for the admin disable,
    with a person's reason; a trigger refuses the system reasons (`replaced`,
    `consolidated_single_wallet`) to anyone but the table owner (the definer functions and
    migrations), so it cannot forge a replace cause or a decider-less row. It could still add an
    extra event with a misleading person's reason to a wallet (it cannot delete one); that only makes
    the re-bind check stricter (a forged `key_compromised` blocks the address), never looser, and
    the wallet row itself is frozen. Existing multi-wallet data was consolidated by the migration
    without a deciding person (`consolidated_single_wallet`, audited).
  - *Self-disable.* A person may cut their own key from an aal2 session; every session of the
    person ends, the current one included. Disabling a proof-bound key never changes assurance.
  - *Metric.* Sign-in failures are counted per method as `mpc_sign_in_failed_total{method,status}`
    (`MpcSignInFailureRate`), replacing the SIWE-only counter.

  Tests: `apps/api/test/wallet-binding.test.ts`, `apps/api/test/admin.test.ts`,
  `apps/api/test/verification.test.ts` ("signing with any of the reviewer's wallets"),
  `apps/api/test/readiness.test.ts`, `apps/api/test/public-dev-wallets.test.ts`,
  `apps/api/test/governance.test.ts`.
- **Implemented (WP6, web):** the session cookie and CSRF boundary (`apps/web/src/proxy.ts`,
  `apps/web/src/lib/bff.ts`).
  - *Token out of page script.* The token is kept in `__Host-mpc_session` — HttpOnly, Secure,
    `SameSite=Strict`, `Path=/`, host-only (plain-http development: unprefixed and not Secure;
    production reads only the prefixed name). The proxy moves it out of every session-issuing
    answer and strips the API-bound `cookie` header; no client module may write an
    `Authorization` header (unit-checked). An injected script can still act as the person while
    the page is open — `script-src` keeps `'unsafe-inline'` (Next hydration) — but cannot carry
    the token away. The legacy `localStorage` token is deleted on load.
  - *Cross-site requests.* A non-safe method is refused (403 `CROSS_SITE_REQUEST_REFUSED`) unless
    `Sec-Fetch-Site: same-origin`, else unless `Origin` equals `WEB_ORIGIN`; with neither header
    it is refused when it rides on the cookie. Sign-in routes are checked that way whatever they
    carry (login CSRF). `SameSite=Strict` is the second layer.
  - *OIDC browser binding.* Kept in `__Host-mpc_oidc` (HttpOnly, 10 minutes, provider and purpose
    included); a callback without it — a link carried to another browser — is refused before the
    API and completes nothing. The callback page removes `code` and `state` from the URL first;
    `/auth/oidc/*` is `Referrer-Policy: no-referrer`, `no-store`. Invitation tokens are read only
    from the URL fragment and removed from the address bar.
  - *Open redirect after sign-in.* `next` is accepted only as a path on this site (no scheme,
    `//`, backslash or control character).
  - *Signing keys.* No sign-in needs a wallet; an account session connects one only to sign, and
    the screen refuses a key not bound to the account on that chain before the wallet opens.
  - *Encoded paths (review M1, L1).* The intercepted routes are recognised by literal path and the
    API decodes percent-encoding, so `/api/v1/auth/email/%76erify` used to reach the verify
    handler as a plain rewrite and answer the token in a readable body (and `%73tart` the OIDC
    binding, `%63allback` skipped the binding check, `%6cogout` left the cookie). The proxy and the
    streaming route refuse such paths with 400 `PATH_ENCODING_REFUSED` (`pathRefusal`); the API
    refuses `/api/v1/auth` paths with percent-encoding before routing
    (`apps/api/src/plugins/path-encoding.ts`). The streaming route rebuilds its upstream path from
    a UUID project id. Tests: `apps/web/test/bff.test.ts`, `apps/web/test/stream-upload.test.ts`,
    `apps/api/test/path-encoding.test.ts`, `apps/web/e2e/account-auth.spec.ts`.
  - *The API sets no cookie.* An API `set-cookie` would pass through the rewrite to the web origin;
    only the proxy writes cookies, and only on the routes it answers itself.
  - *A session ended from its own request.* Revoking the current session from the session list
    (`current: true`) or unlinking the identity it signed in with (`currentSessionEnded: true`)
    clears the cookie in the same answer, as logout does (`sessionEndingRoute`); a refusal, or a
    request that carried its own bearer, leaves the cookie alone (WP7 review L2).
  - *Streaming upload.* The one route the proxy does not handle (it would keep only 10 MiB of the
    body) is a route handler (`apps/web/src/lib/stream-upload.ts`) applying the same cross-site
    refusal, cookie-to-bearer and edge-header rules before piping the body to the API; it issues
    no credential of its own. `apps/web/test/stream-upload.test.ts` pins the matcher and those rules.

  Tests: `apps/web/test/bff.test.ts` (cookie attributes, CSRF, token never in a body, binding
  cookie, callback refusals, no `Authorization` in client code, `next` and fragment handling),
  `apps/web/test/session.test.tsx`, `apps/web/test/auth-screens.test.tsx`,
  `apps/web/test/account-settings.test.tsx`, `apps/web/e2e/account-auth.spec.ts` (HttpOnly and
  SameSite read from the browser, `document.cookie` and storage hold no token, a cross-site POST
  refused, step-up with a virtual passkey).
- **Accepted:**
  - *Targeted sign-in denial.* Anyone who knows an address can spend its 5 code requests per
    15 minutes and hold the owner out of sign-in for that long. Per-address limits are what stop
    code guessing, and lifting them per requester would let a botnet guess; the cost is bounded
    (15 minutes, renewable only by keeping up the requests). Watched by
    `mpc_email_code_addresses_limited` and the `MpcEmailCodeAddressesLimited` alert.
  - *A compromised API process can mint provider sign-ins.* The application role runs start →
    claim → complete itself, so code running as the API can create an aal1 Google / Microsoft
    session for any subject with a linked identity without the provider. The same class as
    email codes (the API holds the code key) and wallet-signature verification (the API checks
    the signature): the database bounds what such a session can do (aal1 only, MFA still
    required), but cannot tell an honest API from a compromised one.
  - *Own-session functions trust the session id the API passes.* `core.list_own_sessions` and
    `core.revoke_own_session` (0126) take the caller's session id, not its token hash, so code
    running as the API could list or end the sessions of any subject whose session id it knows.
    The same class as the provider sign-ins above: the API resolves the token before every call,
    the functions only narrow what an honest API can do, and binding them to the token hash would
    not stop a compromised API, which sees every token in flight. Ending sessions only takes
    access away (WP7 review L5).
  - *TOTP lockout by a first-factor holder.* Someone holding a person's first factor (mailbox or
    identity-provider account) can sign in to aal1 and spend the 5 TOTP attempts per 15 minutes,
    locking the owner's authenticator app for that window. A passkey or a recovery code still
    works, and the attacker already holds the first factor, which is the larger problem.
- **Implemented (AUTH-06, migration 0127):** suspension of a person.
  - *Two people, neither the person.* An administrator (`mpc_operator` / `security_operator`,
    aal3) proposes; another decides (`admin.subject_suspension.propose` / `.approve`). CHECKs refuse
    a decider equal to the proposer and either of them equal to the person; one pending request
    per person. The application role inserts only the proposal's columns and cannot write
    `subjects.suspended_at`; only `core.decide_subject_suspension` decides.
  - *Every way in ends.* Approval sets `suspended_at` and in the same transaction revokes every
    session, passkey, authenticator app, recovery code and linked Google / Microsoft identity,
    removes open login, binding and passkey challenges, supersedes pending sign-in codes, and
    mails `account_suspended_notice`.
  - *Refused like an unknown account.* While suspended, the code request answers as for an
    unknown address (no mail), a code issued before is a wrong code, an identity matches no one,
    a session insert fails (`sessions_a_refuse_suspended`) and an existing session does not
    resolve — so a suspension is not observable from the sign-in screens.
  - *History stays.* Signatures, attestations, gate decisions, roles, wallets and audit are not
    touched.
  - *Reinstatement* clears the mark and opens a 24 h first-enrolment window, like an MFA reset,
    so it joins the recovery separation of 0118 in both directions; suspending, like a rejection,
    is never refused for it.

  Tests: `apps/api/test/subject-suspension.test.ts`, `apps/api/test/oidc.test.ts` ("a suspended
  person's identity"), `apps/web/test/account-admin.test.tsx`, `apps/jobs-worker/test/email.test.ts`.
- **Implemented (migration 0128, security review of 0127):** a suspension closes what is open.
  - *No address change across a suspension (S-M1).* Before 0128, two admins could approve an email
    change to an address they read, have it completed after the suspension, and receive the
    reinstatement's enrolment window there. Now the approving transaction closes the person's
    pending and approved email changes (`expired`, `closed_reason = subject_suspended`) and pending
    MFA resets (`rejected`), each with its own audit row (`admin.subject_suspension.request_closed`).
    While suspended, an email change or MFA reset of the person is refused on propose and approve
    (`SUBJECT_SUSPENDED`, admins only; a bootstrap re-run included), and the public verify answers a
    left-open code as a wrong code.
  - *Three-sided separation.* Whoever proposed or decided an email change, an admin MFA reset or a
    suspension / reinstatement of a person within 30 days takes no part in the other two, for
    suspending as well as reinstating; a request a suspension closed still counts. Rejections are
    never refused.
  - *An enrolment window does not outlive a suspension or an address change.*
    `core.mfa_reset_window_open` counts a window only if it opened after the latest approved
    suspension and the latest completed email change — an address changed inside a reset's window
    no longer lets the new address enrol.
  - *A suspended admin acts no more (S-L1).* The suspension closes what the person proposed and is
    still open (email changes, MFA resets, suspensions, role grants and revocations, registry
    proposals and drafts, break-glass requests) with `closed_reason = proposer_suspended`, audited.
    Since 0132 (F2) also what they approved or created and has not taken effect: an approved email
    change waiting for its code (`approver_suspended`, the code superseded), an approved MFA reset
    whose enrolment window is open (`approver_suspended`; the window stops counting) and a pending
    invitation (`inviter_suspended`, its code and mail dropped) — each audited; people suspended
    before 0132 were swept once by the migration.
    A trigger on each of those tables refuses a suspended subject as proposer or decider
    (`ACTOR_SUSPENDED`, 403), even straight at the database; only the suspension writes
    `closed_reason` (column-level grants, and no row is inserted closed). Since 0133 (L2) the
    trigger reads the actor `FOR KEY SHARE` — the lock the row's foreign key to the actor takes
    in the same statement anyway — so a decision racing its approver's suspension either waits
    and is refused, or commits first and is closed by the suspension; before, it could read
    "not suspended", wait on its foreign key and stay in force. No lock is added, so the order
    below is unchanged. The admin lists (MFA resets, email changes, invitations, suspensions,
    role grants and revocations) answer `closedReason` next to `state` (0133, L3), so a reset
    closed by its approver's suspension no longer reads as an open window and a closed change or
    invitation no longer reads as a plain expiry.
  - *Not covered:* project registration requests are not two-person and are left open.

  Tests: `apps/api/test/suspension-closes-recovery.test.ts` (the reviewer's chain fails at the
  verify, each refusal, the separation in every direction, windows, closures, the database lines),
  `apps/api/test/subject-suspension.test.ts`, `apps/api/test/error-handler.test.ts`.
- **Implemented (migration 0129, re-review of 0128):**
  - *An elevation ends with the suspension (L-1).* Before 0129 an approved break-glass elevation
    stayed `active` through a suspension; after a reinstatement and a new passkey the session held
    `break_glass` again until its expiry, without a new approval. Now an approved suspension
    releases the person's active, unexpired elevations (`released`, cause `subject_suspended`, the
    suspension's decider as releaser), audited with the other closed requests. An approved MFA
    reset does the same (cause `mfa_reset`, `admin.mfa_reset.elevation_released`): the elevation
    was approved for a person holding the factors the reset removes. An expired elevation is left
    as it ended; a rejected reset touches nothing.
  - *The creation window ends at an address change (L-2).* The 24-hour first-enrolment window after
    account creation now closes once an email change of the person has completed or a suspension
    of them has been approved (`core.mfa_creation_window_open`), the barrier 0128 gave the reset
    and reinstatement windows. Two admins can no longer move a new account to an address they read
    and enrol a factor there; an invited person still enrols within 24 hours.

  Tests: `apps/api/test/elevation-and-creation-window.test.ts` (suspend, reinstate, new passkey: no
  `break_glass`; the MFA reset; the reviewer's repro answers `MFA_ENROLMENT_WINDOW_CLOSED`; an
  invited person enrols).
- **Removed (WP7):** the SIWE wallet sign-in and `LEGACY_WALLET_LOGIN`. Migration 0125 revokes any
  live `siwe_legacy` session, adds a check against new ones and drops `core.create_wallet_session`
  and `core.siwe_nonces`; the API has no SIWE route (404) and refuses to start with `LEGACY_WALLET_LOGIN=1`. The
  E2E suite signs every demo person in through the screens (emailed code, then a passkey in
  Chromium's virtual authenticator); its only test-only hooks — the outbox read, the code-limit
  reset and the OIDC relay — act on the run's own database or need `OIDC_TEST_RELAY_URL`, which the
  API accepts only on a loopback host and refuses in production and on mainnet.
- Account email is first factor proof only; it never authorizes anything by itself (plan §3).

**How it happens:** guessing or phishing the first factor · binding an identity-provider
account by its email claim · stealing a session token from the browser · skipping or
downgrading the second factor · abusing recovery, invitations or admin powers to take over
someone else's subject · using a service credential on a person's route.

| Threat | Planned control | Test that will prove it |
|---|---|---|
| **Account takeover** — someone else ends up acting as a subject | Login only by an invited email's code or a linked Google / Microsoft identity, always followed by a second factor; session level (AAL) derived from proven factors, never set by an admin; recovery, email change, suspension and authenticator removal revoke every session of the subject; recovery and email change also revoke every linked identity (0123) | Revocation tests per trigger: every session of the subject returns 401 afterwards, signed history unchanged |
| **Phishing** of the login | Passkey (WebAuthn, RP ID = web host) required for the roles the contract marks phishing-resistant MFA (plan D8); TOTP alone leaves those roles ineffective | TOTP session cannot exercise a passkey-only role; step-up to a passkey makes it effective |
| **Email-code brute force** | 8 random digits, 10-minute TTL, 5 attempts per code, per-email and per-IP limits, HMAC-hashed, single use, constant-time compare | API negative tests: 6th attempt refused, reused code refused, expired code refused, per-email limit holds across IPs |
| **Account enumeration** through the code request | Identical response and timing for invited and uninvited addresses | Response-equality test for invited vs uninvited addresses |
| **Identity-provider misbinding** (nOAuth-style email matching) | Identities link only by Google `(iss, sub)` or Microsoft `(tid, oid)`, and only from an already authenticated flow. `email`, `preferred_username` and `upn` are display-only | A Microsoft token with a matching email but unknown `oid` does not sign in; a Google token with a matching email but unknown `sub` does not sign in |
| **OIDC flow attacks** — CSRF, code injection or replay, token substitution | Authorization code + PKCE; `state` and `nonce` bound to a short-lived HttpOnly cookie; exact redirect URI; issuer and audience checks; Microsoft issuer checked per token `tid` | Tests for wrong state, replayed code, wrong issuer, wrong audience, missing nonce |
| **Session theft** — a token readable by script can be carried away by an injected script | Token in an HttpOnly, Secure, `SameSite=Strict` `__Host-` cookie on the web origin; the same-origin proxy forwards it to the API as the bearer; mutations require `Sec-Fetch-Site: same-origin` or a same-origin `Origin`; absolute TTL 8 h, idle timeout 30 min (WP6) | `apps/web/test/bff.test.ts`; E2E `account-auth.spec.ts`: cookie HttpOnly/Strict, not in `document.cookie` or storage, cross-site POST refused |
| **MFA bypass** — acting with only the first factor, or a weaker factor than the role needs | Priority rules in plan §3: a first-factor session reaches only MFA enrolment, challenge and logout; a role whose AAL or identity-assurance minimum is not met is not effective for the request | First-factor session cannot read restricted data or act; TOTP session cannot use a passkey-only role |
| **Recovery abuse** — a recovery code used as a full login replacement | A recovery code restores only the second factor, forces re-enrolment and revokes sessions; full recovery (lost everything) is a two-person admin action | Recovery tests: code is single use, regeneration voids the old set, sessions revoked, one admin alone cannot complete full recovery |
| **Chained recovery** — the same admins move the address and then reset the factors | Recovery separation (0118): the people of an email change take no part in a reset of that person for 30 days, and the reverse; an approved reset is mailed to the current and the previous addresses | `mfa.test.ts` "recovery separation (0118)": A/B move the address, A/B are refused as reset proposer and decider, the attacker's aal1 session cannot enrol; an uninvolved pair succeeds and both addresses are told |
| **Invitation abuse** — a leaked or forwarded invitation link | Token random and hashed, single use, expires in 72 h, revocable, tied to the invited email (the code to that address is still required); roles are never in the invitation and still need the two-person grant | Tests: reused token, expired token, revoked token, acceptance by a different email refused; accepted account sees "access pending" and no private data |
| **Admin attaches their own login to another subject** | Admins cannot add emails, identities or authenticators to another subject; new subjects come only from invitations, and email change is a two-person action that revokes all sessions | Negative API tests for each of email, identity and authenticator on another subject |
| **Service-token misuse** — a stolen or over-scoped worker credential | Opaque, hashed, bound to a `service` subject, route-scoped, expiring, rotated by CLI with overlap; never accepted on a person-only route (plan D7) | Service token refused on a person-only route and outside its route scope; expired and rotated-out tokens refused |
| **Personal-data handling of email and identity data** | Stored minimally (email, provider ids, display name); excluded from public projections and exports. Production storage, and use of Resend / Google / Microsoft as processors, is **gated on OD-17 and OD-18** | Projection and export allowlist tests; production cut-over stays blocked until OD-17 / OD-18 are answered |

**Not blocked yet**

- The scan worker and the CRE workflow use `scan_result` and `cre_report` service tokens.
- The Google and Microsoft journeys are proven in the browser against a mock provider
  (`apps/web/e2e/oidc.spec.ts`); real Google and Microsoft apps are a staging check (plan §9).
- Email deliverability and the identity providers themselves are outside the repository. A
  compromised mailbox or provider account still yields the first factor; the second factor is
  what stops it.

## 4. Summary of what is open now

| # | Open item | Where |
|---|---|---|
| 1 | Jurisdiction of originals undecided | OD-17 — **blocks production** |
| 2 | Ownership of encryption keys undecided | OD-18 — **blocks production** |
| 3 | Actual scanner and edge-limit state of the deployed stack unconfirmed | open items on scanner operation and rate limiting |
| 4 | Wallet funding cap is an operations procedure | `docs/operations/deployment.md`, "Loss cap for the anchor wallet" |
| 5 | Whether credential revocation is published | Excluded by current rules. Raise a new open item if needed |
| 6 | No public-boundary check for new `SECURITY DEFINER` functions | follow-up candidate |
| 7 | Egress restriction for notification sinks | follow-up candidate |
| 8 | Image signing and verification | follow-up candidate |
| 9 | Account authentication controls (T10): WP1–WP7 and suspension implemented | [`../account-authentication-plan.md`](../account-authentication-plan.md) — production also gated on OD-17 / OD-18 |

**1 and 2 come before the rest.** While those two are open, nothing can be said about what is
being blocked with respect to A3 (original evidence).

## 5. When to update this document

### Evidence ledger boundary review (2026-10-23)

Catalog-linked claims bind an approved catalog version, structured values and supporting
documents to immutable claim content. New structured review snapshots use version 2 of the
evidence commitment; legacy unstructured commitments retain their version 1 bytes. The
server validates field declarations, project-scoped receipts and scanned documents. A
correction appends a claim; it does not rewrite previously signed content.

Catalog definitions cannot use the seven fixed project-matrix keys. Historical definitions
with colliding keys remain immutable and are excluded from catalog selection and computed
ledger inputs. Confirmation writes for those keys require explicit `factScope: "legacy"`;
`factScope: "catalog"` cannot write a fixed matrix row. Older ambiguous requests fail closed,
while the current matrix client declares the namespace on every write.

Computed ledger snapshots are separate from manual project confirmations and existing
readiness or gate decisions. Their private input basis contains evidence and rule inputs,
so snapshot reads require project authorization and tenant RLS. Recompute requests accept
no caller-provided results or evaluation time. Snapshots reject update, delete and truncate.
Publication checks the recorded input commitment, the exact public summary, and the current
private basis and outcomes, at both draft and independent approval time.

`core.public_evidence_ledger_current` is a new `SECURITY DEFINER` boundary. It resolves only
published project versions, joins their recorded snapshot in the same tenant and project,
and returns fixed warning codes for the already published item/version basis. It returns
no new claims, document references, private inputs, natural-person names or free-text reasons.
Signed limitations and pseudonymous review qualifications enter the frozen public summary
only through the existing disclosure preview and independent approval. The current-warning
overlay is explicitly outside the anchored content and cannot change an old content hash.

The existing jobs worker can read the required assessment inputs and insert immutable
snapshots and audit events. It gains no authority to edit claims, manual facts, policies,
approvals or published versions. Because the worker bypasses RLS, every project-specific
input query must also constrain the tenant explicitly; a regression test covers competing
jurisdiction profiles in two tenants using the actual worker role. Worker failures are
reported and retried; request-time health checks prevent an overdue sweep from hiding an
expired or revoked evidence basis.

These checks do not resolve the production data-residency, key-ownership, or release
prerequisites listed above, and an evidence stage is not permission to operate or invest.

- When a `SECURITY DEFINER` function is added or its `WHERE` clause changes (T2, T3)
- When a page or endpoint is added to the public surface (T2, T5)
- When a new system identity (worker, service account) is created (T1, T3)
- When OD-17 or OD-18 is resolved (§4 items 1 and 2)

A threat model that is not updated **gives the reader false reassurance.** If there is nothing to
change, write "checked, nothing changed" with the date.

### Evidence-ledger publication concurrency

Ledger publication takes transaction-scoped advisory locks before reading current evidence:
a shared tenant-configuration lock and an exclusive tenant/project lock. It also locks the
project row with `FOR UPDATE NOWAIT`, catching lifecycle writers that have not reached their
write trigger. The invoker-rights function checks tenant access, has a fixed search path,
returns no rows and is executable only by the application role. Failed advisory-lock attempts
or a locked project row return a retryable publication error; rollback removes the request's
idempotency record so the same key remains usable. The assessment clock is refreshed after
acquisition.

Database row triggers make API, worker and direct SQL writes participate in the same barrier,
including inserts. Project inputs acquire the matching exclusive project lock; shared
definitions acquire an exclusive tenant-configuration lock. Moves lock both old and new scopes
in deterministic order. Covered input tables reject `TRUNCATE`, which cannot be scoped by row.
Plain reads, unrelated projects' evidence writes and other tenants' configuration writes can
continue. Same-tenant configuration writes wait for publications, while publication fails fast
when a conflicting writer already holds the barrier. Changes to evaluator input relations must
update the trigger coverage and concurrency regression tests.

The private assessment input also commits to the policy engine's applicable requirement IDs.
Public grade warnings use this recorded applicability and the approved policy's minimum
grade; private requirement IDs remain outside the public projection. Older ledger snapshots
without this metadata conservatively warn on a below-minimum grade and may need a new
assessment to disambiguate requirements that did not apply.

### CRE status-relay proof of concept

The isolated development workflow reads an authenticated, idempotent Registry report and
relays only approved public identity/version/hash and current health metadata. It neither
publishes records nor alters RegistryAnchor, readiness decisions or financial functionality.
Source collection is separate: a real authority API is not required to relay our own Registry
state. Mock-source and mock-forwarder checks do not establish a live official integration or
DON authentication.

The API enforces existing project permissions and tenant isolation and serializes concurrent
requests sharing an idempotency key. Reports retain immutable approved content while carrying
adverse live state separately. Their sequence is scoped to the project, avoiding a public
counter of other tenants' activity. The consumer authenticates the pinned forwarder and
workflow ID/owner, binds chain and receiver, rejects replay/version rollback/hash replacement,
and stops treating a positive observation as current when its transport TTL expires.
Health is evaluated using an explicit clock sampled after blocking publication/report locks.
The report's `observedAt` and TTL use that same evaluation clock. A later wall-clock sample
only checks that evaluation has not spent the TTL; if it has, the API returns retryable
`503 CRE_OBSERVATION_EXPIRED` without storing a report or its idempotency reservation.
Lock waits occur before evaluation, and a delayed health result is never relabeled as newer.
The existing public overlay keeps its original one-argument transaction-time interface.

The workflow is limited to the local Anvil chain. A positive observation describes health at
its recorded time, not a guarantee through its TTL, a passing stage or legal/factual approval.
The forwarder, workflow and Registry API remain trusted sources of the reported state; a
compromised trusted workflow can lie. Confidential source documents, source-query identifiers,
tenant IDs and credentials are excluded from the onchain report. Live DON execution, public
chain deployment and production credential/data handling require separate verification.

## Upgradeable CRE Receiver

The BSC Testnet Receiver uses an atomically initialized ERC-1967 UUPS proxy. Its
owner (two-step transfer) may bind a workflow and upgrade the implementation; that
owner is an additional live trust authority. Empty workflow identity is a closed
bootstrap state, not a wildcard. Only the configured Forwarder and exact nonzero
workflow ID/owner may deliver reports. Reports bind chain and proxy address, retain
TTL/sequence/version/hash guards, and do not modify existing anchor state. The
implementation is initialization-locked; upgrades require reviewed storage-layout
compatibility. CRE-specific API chain/RPC configuration does not alter the anchor
chain. RPC tracing also excludes CRE endpoint origins, including credentials.
