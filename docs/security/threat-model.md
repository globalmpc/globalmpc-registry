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

- The spend cap `ANCHOR_DAILY_SPEND_CAP_WEI` (no default; the worker refuses to start when unset).
  The total that can be burned per day is fixed — even with the key, the wallet cannot be drained
  at once.
- The gas cap `ANCHOR_FEE_CAP_GWEI`. Blocks submissions at abnormal prices.
- The retry cap `ANCHOR_MAX_ATTEMPTS`.
- Secrets are **stored as references only** — `file:` and `env:` forms; the values are not in the
  repository (spec 05 §5.12).

**Not blocked yet**

- The funding cap **cannot be enforced by code.** Holding only one day's worth in the wallet is a
  finance and operations procedure (`deploy/README.md`, "Loss cap for the anchor wallet").
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
- The `scan` profile is **on by default.** Turning it off is an explicit act.
- A dead scanner is not silent — `core.worker_heartbeats` records liveness, and the Data Room
  says "the scanner has never reported — waiting will not resolve this."

**Not blocked yet**

- Whether `scan` is actually enabled in the deployed stack **cannot be known from inside the
  repository.**
- ClamAV is amd64-only, so it runs under emulation on Apple Silicon.

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
| 3 | Actual profile and edge-limit state of the deployed stack unconfirmed | open items on the scan profile and rate limiting |
| 4 | Wallet funding cap is an operations procedure | `deploy/README.md`, "Loss cap for the anchor wallet" |
| 5 | Whether credential revocation is published | Excluded by current rules. Raise a new open item if needed |
| 6 | No public-boundary check for new `SECURITY DEFINER` functions | follow-up candidate |
| 7 | Egress restriction for notification sinks | follow-up candidate |
| 8 | Image signing and verification | follow-up candidate |

**1 and 2 come before the rest.** While those two are open, nothing can be said about what is
being blocked with respect to A3 (original evidence).

## 5. When to update this document

- When a `SECURITY DEFINER` function is added or its `WHERE` clause changes (T2, T3)
- When a page or endpoint is added to the public surface (T2, T5)
- When a new system identity (worker, service account) is created (T1, T3)
- When OD-17 or OD-18 is resolved (§4 items 1 and 2)

A threat model that is not updated **gives the reader false reassurance.** If there is nothing to
change, write "checked, nothing changed" with the date.
