# MPC dApp

A BNB Chain anchor with a user-facing Explorer and Workspace.

Records for mining assets are registered, reviewed, and published; **only what is
published** is folded into a Merkle root and anchored on-chain. Anyone can recompute
the proof from the public Explorer.

`design-system/` is a **runtime dependency**, not documentation: the web app
references it through `link:../../design-system`, and `apps/web/src/app/globals.css`
imports its CSS. Moving it breaks the build.

Notation used in comments, such as `spec 05 §5.3` and `OD-17`, is listed in
[`docs/spec-sections.md`](docs/spec-sections.md).

## What exists now

**Contract packages**

| Package | Contents | Tests |
|---|---|---|
| `packages/canonical` | Restricted JCS profile, leaf encoding, Merkle, golden vectors | 88 |
| `packages/domain` | 12 source results, grade derivation, 12 state machines, invariants | 213 |
| `packages/policy` | Readiness rule schema, deterministic evaluation engine | 44 |
| `packages/db` | Schema, RLS, append-only guards, composite FKs, migration checksums | 61 |
| `packages/api-contract` | Zod contract → OpenAPI 3.1, SIWE, authorization | 43 |
| `packages/ui` | Status display mapping, R-04 forbidden-term lint, three-depth consistency | 37 |
| `packages/config` | Secret reference resolution (`file:`, `env:`), audit fingerprints that do not expose values | 14 |
| `packages/storage` | Object storage — key rules, quarantine state machine, memory and S3 implementations | 17 |

**Apps**

| App | Contents | Tests |
|---|---|---|
| `apps/api` | Fastify 5. SIWE sessions; upload, evidence, review, readiness, Registry, anchor, audit, governance, Authority, and provenance lookup — 81 routes | 674 |
| `apps/web` | Next.js 16. Data Room, Verification, readiness, Gate, publishing, Anchor, audit, governance, Authority, Explorer. Real wallet signing | unit 20 · E2E 88 |
| `apps/worker` | Outbox publishing, anchor submission/confirmation/reorg, daily gas cap (O1), Safe proposal and execution tracking, ClamAV scanning | 92 |

**Contracts**

`contracts/` — `RegistryAnchorV1` + 10 deferred interfaces, 29 Foundry tests (including fuzz and invariant).

Total: vitest 1303 + Playwright 88 + Foundry 29 + route 81. (measured 2026-09-14)

## Running

```bash
pnpm install

# Unit and integration tests (without DATABASE_URL, DB tests are skipped)
DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm test

# Typecheck (all packages and apps; the web app runs next typegen first, then checks)
pnpm typecheck

# Regenerate OpenAPI and check for drift
pnpm check:openapi

# Browser E2E (starts the API and web app automatically)
# E2E uses its own DB. compose does not create it, so create it once yourself.
createdb -h localhost -p 55432 -U postgres mpc_e2e
pnpm --filter @mpc/web test:e2e

# Contracts
cd contracts && forge test

# Full stack in containers (Postgres, MinIO, ClamAV, anvil, API, two workers, web)
docker compose up --build

# E2E including chain confirmation (requires anvil and the anchor worker)
E2E_CHAIN=1 pnpm --filter @mpc/web exec playwright test anchor-chain
```

### Golden path

In R1 the following sequence runs end to end in code.

```
SIWE login → project registration → Source Receipt → Claim (grade derived automatically)
→ Verification Case (evidence snapshot pinned) → EIP-712 signature
→ Readiness assessment → Gate Decision → Registry publication → Merkle batch
→ chain submission → confirmation depth reached → unauthenticated Explorer lookup → inclusion proof
```

`included` becomes true only **after confirmation**. When the batch is created it is
`created`, and it is still false in the `included` state, once the batch is in a block (06 §6.8).

Each step is verified by integration tests in `apps/api/test/`, and
`apps/web/e2e/golden-path.spec.ts` runs the same flow in the browser as a single
scenario — including the role changes between steps.

### Running a local stack

```bash
# 1) PostgreSQL
initdb -D ./.pgdata -U postgres --auth=trust
pg_ctl -D ./.pgdata -o "-p 5432 -c unix_socket_directories=/tmp" start
createdb -h localhost -U postgres mpc_dev
DATABASE_URL="postgres://postgres@localhost:5432/mpc_dev" pnpm --filter @mpc/db migrate

# 2) App role
psql "postgres://postgres@localhost:5432/mpc_dev" -c \
  "CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
   GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login;"

# 3) Generate demo account keys. They are not in the repository (`apps/web/src/lib/session.tsx`).
#    The seed and the web app must see the **same values** — otherwise the accounts on
#    screen and the addresses holding roles diverge, and login succeeds with no permissions.
export MPC_DEMO_KEYS=$(node -e 'const c=require("node:crypto");
const labels=["Operator A","Operator B","Operator C","Reader A","Steward A",
  "Approver A","Reviewer A","Proposer A","Voter A","Scan Service"];
console.log(JSON.stringify(Object.fromEntries(
  labels.map((l)=>[l,"0x"+c.randomBytes(32).toString("hex")]))))')

# 4) Seed demo accounts
DATABASE_URL="postgres://postgres@localhost:5432/mpc_dev" \
E2E_DEMO_ACCOUNT_KEYS="$MPC_DEMO_KEYS" \
  pnpm --filter @mpc/web seed:e2e

# 5) API
DATABASE_URL="postgres://mpc_app_login:app@localhost:5432/mpc_dev" \
PORT=3001 SIWE_DOMAIN=localhost:3000 SIWE_URI=http://localhost:3000 \
CHAIN_ID=97 SESSION_SECRET="local-dev-session-secret-32chars-min" \
  pnpm --filter @mpc/api start

# 6) Web
#    Pass the value created in 3) unchanged. Without it the login screen offers only
#    wallet connection — by default, demo keys are kept out of deployment builds.
NEXT_PUBLIC_DEMO_ACCOUNT_KEYS="$MPC_DEMO_KEYS" pnpm --filter @mpc/web dev

# 7) Local chain and anchor worker (optional)
#    EOA submission is enabled only on local (31337) and BNB testnet (97). On any other
#    chain, setting ANCHOR_SAFE_ADDRESS makes it only create proposals; otherwise it does nothing.
anvil --port 8545 --chain-id 97 --block-time 1 &

cd contracts
ANCHOR_DEPLOYER_KEY=<local-only key> \
  forge script script/DeployRegistryAnchor.s.sol:DeployRegistryAnchor \
  --rpc-url http://localhost:8545 --broadcast

# The worker operates across tenants, so it connects with a dedicated role (0012).
psql "postgres://postgres@localhost:5432/mpc_dev" -c \
  "CREATE ROLE mpc_worker_login LOGIN PASSWORD 'worker' IN ROLE mpc_worker;
   GRANT USAGE ON SCHEMA core, chain, audit TO mpc_worker_login;
   ALTER ROLE mpc_worker_login BYPASSRLS;"

DATABASE_URL="postgres://mpc_worker_login:worker@localhost:5432/mpc_dev" \
CHAIN_RPC_URL=http://localhost:8545 CHAIN_ID=97 \
ANCHOR_CONTRACT_ADDRESS=<deployed address> \
ANCHOR_SIGNER_PRIVATE_KEY=<local-only key> ANCHOR_CONFIRMATIONS=2 \
  pnpm --filter @mpc/worker start:anchor
```

**The chain id must be the same across the whole stack.** If the `chain_id` recorded
by the API differs from the chain the worker queries, transactions are never picked up.

You can try it with the demo accounts at http://localhost:3000 (they appear only in
runs given `NEXT_PUBLIC_DEMO_ACCOUNT_KEYS`). Roles are separated, so no single account
can go through the whole flow — Operator A (registration, publishing), Steward A
(evidence, claims, review assignment), Reviewer A (signing), Approver A (gate decisions),
Operator B (another tenant), Operator C (empty state), Reader A (no role).

## Pinned dependency versions

`pnpm.overrides` in `package.json` pins `viem`, `@aws-sdk/*`, and `@smithy/*` to exact
versions. This is because of **supply-chain policy**, not preference.

pnpm rejects recently published packages via `minimumReleaseAge` — releases containing
malicious code usually surface within a few days, so not pulling in brand-new versions
automatically is the defense. With a range (`^2.21.0`), depending on install time the
lockfile can pick up a version that fails the policy, and while local installs pass on
cache, **only clean installs (CI, image builds) break.**

When upgrading a dependency, check its publish time.

```bash
npm view <package> time --json | jq 'to_entries | last'
```

## Dependency direction

```
canonical ← domain ← policy ← api-contract ← apps/api
                  ↖ db ← apps/worker
                  ↖ ui ← apps/web
```

Reverse dependencies are forbidden. `ui` does not reference `db`.

## What this repository enforces

These items are fixed **in code and constraints**, not in planning-document prose.
Bypassing them breaks tests or gets rejected by the DB.

- A canonical payload cannot contain JSON numbers → floating-point reproducibility problems are ruled out at the source
- No privilege can change an anchor batch's root → verified by a Foundry invariant over 8192 runs
- Not even a superuser can UPDATE/DELETE `audit.events` → trigger
- A readiness assessment cannot be UPDATEd at all → trigger + no PATCH path in the API
- An attestation with empty `limitations` is not stored → DB CHECK constraint
- A public projection rejects fields outside the allowlist → Zod `.strict()`
- The 12 source results are a DB enum → no aliasing or merging
- Protocol governance cannot propose a project disposition → enforced three times: domain, API, contract
- **References across a tenant boundary cannot be created** → composite FKs. PostgreSQL FK
  checks bypass RLS, so the DB blocks them directly with a `(tenant_id, id)` composite key
- **Contract and implementation cannot diverge** → the `contract-parity` test compares them in both directions
- **Authentication is SIWE signatures only** → the development wallet-header path was removed in R1.
  Tokens are issued only after signature verification, only their hashes are stored in the DB,
  and logging out invalidates them immediately
- **batchId 0 cannot be anchored** → it conflicts with the meaning of `supersededBy == 0`. This
  defect was found by invariant fuzzing
- **API secrets are not stored in receipts** → the authentication method is an enum, so there is no field to put a token value in
- **A review without evidence cannot be created** → case creation is rejected if the evidence snapshot is empty
- **If the evidence changes after signing, the signature is invalid** → snapshot hash comparison prevents substitution
- An upload judged infected has no path to promotion as evidence → state machine reachability check
- **The anchor worker does not start unless a daily total gas spend is set** →
  `ANCHOR_DAILY_SPEND_CAP_WEI` has no default (O1)
- **Block inclusion cannot be displayed as confirmation** → `included` is not `confirmed` until
  the confirmation depth is reached, and a DB CHECK rejects `confirmed` without block information
- **A reverted confirmation cannot be erased** → `chain.reorg_events` is append-only and persists
  even after reconfirmation. The worker role has no UPDATE or DELETE privilege
- **An EOA cannot anchor alone on mainnet** → the allowed-chain list contains only local and
  testnet. The contract's `ANCHOR_SUBMITTER_ROLE` belongs to the Safe multisig
- **The gas wallet is not drained by endless retries** → submission stops once the fee cap or
  the attempt cap is exceeded (O1's loss cap)
- **Review scope cannot be changed after the fact** → there is no UPDATE or DELETE privilege on
  `verification_case_claims`
- **Concurrent edits do not overwrite earlier judgments** → mutations that bump a version require
  `If-Match`, and the version is compared after locking the row. A parity test checks in both
  directions that the contract's `requiresIfMatch` matches actual rejection
- **Review status cannot change without a reason** → the API schema and a DB CHECK each reject an
  empty reason, and the path taken is kept append-only in `verification_case_transitions`
- **Raising a dispute does not erase the signature** → only the status changes to `disputed`;
  `payload_hash` and `signature` stay as they are. Deleting a signature is indistinguishable
  from hiding a flawed review
- **The audit screen does not expose payloads** → responses have no `detail` field. Reading also
  requires the `audit.read` permission
- **The role in an audit record is not a guess** → `effective_role` holds the role of the binding
  that **allowed** the action. `assertAuthorized` returns it and `AuditEntry.effectiveRole` is
  required, so code that does not pass the value does not compile.
  Paths that do not go through an authorization check are recorded as `assignment_bound` or
  `deploy_bound` instead of a role name — a check that did not happen is not recorded as if it did
- **A session's role order does not vary between runs** → `resolve_role_bindings` returns
  bindings sorted from narrowest first
- **API responses are not interpreted as documents in the browser** → `default-src 'none'` and
  `frame-ancestors 'none'` are attached to every response, including 401, 404, and 429
- **An upload does not become evidence directly** → it enters a quarantine path and is promoted
  only after passing a scan. The `scanned_infected → promoted` path does not exist in the state machine
- **Storage keys do not contain file names** → keys flow through logs, URLs, and error messages
- **Secrets do not remain in the process environment** → files mounted via `file:` references are read.
  The startup log records only the scheme and a 12-character fingerprint, not the value
- **Production does not start with in-memory storage** → `loadConfig` blocks startup
- **The storage region has no default** → `OBJECT_STORE=s3` requires `OBJECT_REGION`.
  A default would mean data gets stored somewhere without anyone deciding (OD-17). The draft-stage
  value is `ap-northeast-2` (Korea) and is to be reviewed again before prod
- **Sensitive-grade material is not accepted** → `confidential`, `pii`, and `whistleblower` are
  rejected with 422. Storage currently uses provider-managed keys and has no per-tenant key
  separation or destruction procedure. Real contracts and personal data are uploaded only after
  the secured route opens (OD-18)
- **Encryption cannot be turned off in production** → `OBJECT_SSE=none` is for local MinIO only
- **Scan results cannot be produced from the UI** → scanning is done by a separate worker, and
  Data Room has no such button. A scanner failure is recorded as an error, not an infection, and retried
- **Uploaders cannot pass their own files** → only `scan_service` holds `upload.scan_result`.
  `source.upload` is not reused
- **A result cannot be declared ignoring the votes** → closing a vote must match the tally;
  otherwise it is rejected with `TALLY_MISMATCH`. A DB trigger blocks vote changes after closing
- **Votes do not create off-chain facts** → governance responses state this every time through
  `limitations`, and proposals on forbidden subjects are rejected outright
- **Unverified integrations are not shown as active** → sources in `pending_access` are not
  called and do not disappear from the list. The reason they cannot be used is shown alongside
- **Accessibility violations are zero** → axe scans 8 screens and enforces zero violations
- **Warnings cannot be reworded per screen** → boundary wording originates in `@mpc/ui`, and every
  screen renders that same text
- **Voters cannot set their own vote weight** → when a snapshot exists, the value in the request
  body is ignored. A trigger rejects modification of the snapshot block and the recorded weight
- **A failed lookup is not read as a zero balance** → zero is the fact "holds no tokens"; a failure
  is "unknown". Recording the latter as the former silently takes away voting rights
- **A 404 is not read as a source outage** → the adapter normalizes to the 12 results.
  Mixing "no record" with "source outage" means retrying forever for a record that does not exist
- **A claim points to its own evidence** → `source_receipt_id`. If missing,
  `core.claims_without_evidence` surfaces it. It is not deleted or downgraded automatically
- **When a source goes down, the claims and attestations based on it are flagged accordingly** →
  trigger 0023. Review status does not change — the review really happened; what changed is the evidence
- **Finished attestations are not touched again** → `revoked` and `superseded` are not propagation
  targets. Touching them would blur "what was valid when"
- **Public records are not taken down automatically** → when evidence is shaken only a signal is
  left, and supersede/revoke is decided by a person holding the `registry.revoke` permission. If
  public records disappeared because one integration broke, a source outage would amount to record deletion
- **Closing a signal does not change its target** → if one request did two things, it would be
  impossible to tell later what was executed. To actually take something down, call revoke separately
- **Trading routes do not exist** → `subscriptions`, `orders`, `transfers`, and
  `custody` return 404. They are not hidden behind a flag; they were not built (OD-07)
- **An integration cannot become `active` without a call target** → DB CHECK. An API integration
  without an endpoint is not an integration but a label saying it is integrated
- **Requests to registries cannot go out in plaintext** → endpoints allow https only and reject
  credentials in the URL (`user:pass@`). Redirects are not followed either
- **Retries do not call the source again** → an Idempotency-Key is taken before the external
  call. A registry's rate limit does not know our retry count
- **Whoever registered an authority cannot approve it** → blocked even when holding both permissions.
  This is the "operator-only transition to accepted" that 02 §2.8 forbids
- **An integration for an unapproved authority cannot become active** → DB trigger. Turning on an
  integration does not amount to approving the authority
- **A weaker channel is not an easier channel** → manual confirmation requires a second review by a
  different person, signed documents require signature verification, and bulk export requires a
  schema check before confirmation (AC-29)
- **The uploader cannot fabricate the basis for confirmation** → the server verifies signatures
  against a registered public key, extracts bulk fields from the file itself, and API-collection
  confirmation comes only from a path the server called. DB constraints require `verifiedBy`,
  `documentHash`, and the verifier version (2026-09-10 audit A1)
- **A 200 with valid JSON is not a confirmation** → confirmation requires the fields the integration
  declared. Without a declaration, a person reviews it. Responses have a size cap (A7)
- **Connections go only to the address that was checked** → names are not re-resolved. All IPv6
  outside the public range (2000::/3) is blocked (A2)
- **Confirmed transactions do not starve pending ones** → states that need progress are picked
  first, and confirmed rows are revisited only after the reorg-watch interval has passed

## What does not exist yet

**API**: all 81 routes in the contract (`ROUTES`) are implemented. `plannedRoutes()` is empty.

**Unimplemented gaps**

- **There is no real source to call** — the operational path from registration and approval to
  integration setup and lookup all exists, but the access rights under OD-42 have not been
  confirmed, so there is nothing to register. Integrations in `pending_access` are not called, and
  a DB constraint blocks `active` for integrations without a call target.
- **Sensitive material cannot be accepted yet** — following the draft decision on OD-18 there is only
  one storage path and sensitive grades are rejected. The secured route will be built when tenant
  key separation, rotation, and crypto-shredding are decided together.
- **The governance token has not been deployed** — the snapshot code exists, and without
  `GOVERNANCE_TOKEN_ADDRESS` it falls back to manual weights. The response's `weightSource`
  states which one applies. An archive node is also required (OD-24).
- **Safe execution is done by people** — the worker submits proposals and reads back execution
  results, but Safe owners collect signatures and execute. That separation is the design.
- **There is no Asset/Offering trading functionality** — OD-07 decided "do not implement it or keep it
  hidden". Only the activation gate exists, and the UI shows the remaining conditions and owners.
- **Code cannot enforce a funding cap for the anchor signer wallet** — daily spend is capped by
  `ANCHOR_DAILY_SPEND_CAP_WEI`, but how much to keep in the wallet is a finance and operations
  procedure (`deploy/README.md`).
- **There is no performance target** — `throughput.test.ts` measures and prints, but there is no pass
  criterion until one is given via `PERF_MAX_P95_MS`. Once OD-32 is decided, it goes in as a CI environment variable.
- **ClamAV is not run in E2E** — downloading the signature DB dominates test time. On arm64 it
  runs natively with an image built in-house in `deploy/clamav/` (2026-08-28). The earlier
  "amd64 only" description became outdated at that point.

No prod deployment until OD-17 (data jurisdiction) and OD-18 (key ownership) are resolved.

## License

- Code: [Apache License 2.0](LICENSE)
- The MPC name and logos are excluded from the license —
  [`TRADEMARK.md`](TRADEMARK.md)
- Vendored libraries keep their own licenses

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md), not through public issues.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md).
