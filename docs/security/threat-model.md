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
          [ holds a SIWE session ]
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
- Whether 429-rate and SIWE-failure-rate alerts are actually wired in the observability stack is
  unconfirmed.

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
