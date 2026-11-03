# Deployment configuration

The local stack is defined in `docker/docker-compose.yml`. Docker image definitions live alongside it in `docker/`;
service configuration and database setup live beside the responsibilities they support.
Production values (hosts, domains, credentials, actual caps) never enter the repository.
Run the commands in this guide from the repository root.

| Path (from repository root) | Contents |
|---|---|
| [`docker/Dockerfile`](../../docker/Dockerfile) | API and web image |
| [`docker/Dockerfile.workers`](../../docker/Dockerfile.workers) | Independent worker images |
| [`docker/Dockerfile.clamav`](../../docker/Dockerfile.clamav) | Antivirus image without application credentials |
| [`docker/clamav/`](../../docker/clamav/) | Isolated ClamAV configuration and daemon/updater supervision |
| [`packages/db/sql/login-roles.sql`](../../packages/db/sql/login-roles.sql) | Login roles subject to RLS, so the app never runs as superuser — local only (public passwords `app`/`worker`); shared clusters use `pnpm --filter @mpc/db login-roles` with generated `APP_DB_PASSWORD`/`WORKER_DB_PASSWORD` (at least 32 characters, e.g. `openssl rand -hex 32`) |
| [`config/local-secrets/`](../../config/local-secrets/) | Optional public fixtures for file-reference configuration; not mounted by Compose |
| [`config/observability/`](../../config/observability/) | Prometheus scrape configuration, alert rules and Alertmanager configuration |
| [Backup and restore](backup-restore.md) | What the backup, restore and drill scripts capture, refuse and verify |
| [Release rollback](rollback.md) | Compatibility checks and the release rollback procedure |
| [Mainnet contract](mainnet-contract.md) | Contract deployment procedure for mainnet (56) and what must be settled first |
| [Testnet contract](testnet-contract.md) | Contract deployment procedure for opBNB testnet (5611) |

## Secret injection

Compose injects secret values directly through each service's `environment` block. It uses
public local defaults when an override is unset or empty, and does not require secret files or
mount `config/local-secrets/`. The application also supports optional `file:`, `env:` and
`plain:` references; these are configuration choices, not required deployment conventions.

| Container variable | Compose override | Scope |
| --- | --- | --- |
| `DATABASE_URL` | `API_DATABASE_URL` | API application login |
| `DATABASE_URL` | `WORKER_DATABASE_URL` | Jobs, anchor and scan worker login |
| `SESSION_SECRET` | `SESSION_SECRET` | API only |
| `OBJECT_SECRET_ACCESS_KEY` | `OBJECT_SECRET_ACCESS_KEY` | API and scan worker |
| `ANCHOR_SIGNER_PRIVATE_KEY` | `ANCHOR_SIGNER_PRIVATE_KEY` | Anchor worker only |
| `SCAN_SERVICE_PRIVATE_KEY` | `SCAN_SERVICE_PRIVATE_KEY` | Scan worker only |

Compose uses separate `API_DATABASE_URL` and `WORKER_DATABASE_URL` inputs so a host-process
`DATABASE_URL` cannot silently replace either container login. ClamAV and web receive none
of these credentials. Existing published hashes, roles and
approval rules are unaffected by the injection format. Values belong to each environment;
platforms may inject them directly from their secret manager. Direct values are visible to
people with container-inspection access; file references do not protect against a compromised
process authorized to read that file either.

The Compose file remains a local/demo stack, including local database and storage setup.
`.env.example` describes direct host-process execution, with host addresses. Keep it separate
from a Compose override file, whose addresses must resolve inside the container network:

```sh
docker compose --env-file /path/to/local-compose.env -f docker/docker-compose.yml up -d
```

Use environment-specific deployment configuration and newly provisioned credentials for dev
or production; changing these six variables does not convert the local infrastructure setup
into a production deployment.

**Notification webhook signing secrets** are references too, but only inside a namespace
that holds nothing else: `env:WEBHOOK_SECRET_<NAME>` (`NAME` is `[A-Z0-9_]`, 1–64 characters)
or `file:/run/secrets/webhook_<name>` (`name` is `[A-Za-z0-9_-]`, 1–64 characters, no
subdirectories). The API refuses any other reference when a sink is registered, and the
worker refuses it again before reading — so a sink cannot point the worker at its database
URL or the signer key. Provision each tenant's signing secret under one of those names
(for Docker secrets, name the secret `webhook_<name>`).

## Database roles for the operator CLIs

`pnpm --filter @mpc/db login-roles` and `pnpm --filter @mpc/api bootstrap` run over the
migration connection. Both check the connecting role before changing anything and name what
is missing:

- **bootstrap** needs superuser or `BYPASSRLS`: it writes across tenants and checks wallets
  against every tenant.
- **login-roles** needs superuser, or on PostgreSQL 16 or later a role with `CREATEROLE` and
  `BYPASSRLS`, `ADMIN OPTION` on `mpc_app_login`/`mpc_worker_login` (or, for one not created yet,
  on `mpc_app`/`mpc_worker`), and `USAGE WITH GRANT OPTION` on schemas `core`, `chain` and
  `audit`. Before 16 only a superuser can give `mpc_worker_login` `BYPASSRLS`.

login-roles requires each password to be at least 32 characters. That checks length only, not
randomness — a 32-character phrase passes and is still guessable — so generate each one with
`openssl rand -hex 32`, never type or reuse one. It sends SCRAM verifiers, never passwords. A verifier cannot be used to
log in, and one of a random password that long cannot be guessed offline, so that is what a
leaked verifier rests on. As defence in depth the run turns statement logging off for its own
transaction. A role that may not do that (not superuser, and no `GRANT SET ON PARAMETER`) is
refused before any change when the server would log every run's statements (`log_statement`
`ddl`, `mod` or `all`, any `log_min_duration_statement` of 0 or more, `log_min_duration_sample`
of 0 or more with a nonzero `log_statement_sample_rate`, or `pgaudit.log` covering `role`).
Change those settings for the run, or use a role that may set them. A nonzero
`log_transaction_sample_rate` refuses every role, superuser included: it is decided when the
transaction starts. Otherwise the run goes ahead and prints a `Login roles warning` line naming
the settings it could not change. On a default configuration that includes
`log_min_error_statement = error`, which logs only a statement that fails: the password
statements run last, after everything else succeeded and with lock and statement timeouts off.
It also warns when `pg_stat_statements.track_utility` is on.
These rules were checked on PostgreSQL 17; Aurora's `rds_superuser` was not tested.

**Before running migrations,** check for long-open transactions. A `-- migrate:no-transaction`
migration (0104, 0106) runs `CREATE INDEX CONCURRENTLY`, which waits for every transaction in the
database that is older than the build — on any table, not only the one indexed — so one
connection left `idle in transaction` stalls `migrate` (holding the migration lock) until it
ends. 0107 creates triggers on `chain.transactions` and `chain.anchor_proposals`, so it waits for
open transactions that wrote to them, and every later writer queues behind it; run by a role that
is neither superuser nor `BYPASSRLS`, its backfill also holds both tables exclusively, readers
included, for one pass over each. That backfill gives up after waiting 5 seconds for its lock
(`lock_timeout`) and fails with nothing of it applied; rerun `migrate` once the open
transactions are gone. Look first, and end or wait out what you find:

```sql
SELECT pid, usename, application_name, state, now() - xact_start AS open_for
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start;
```

Run `migrate` before starting workers of a new release: from 0107 the anchor worker registers its
configured contract in `chain.anchor_contracts` at startup and exits if that table is missing.

## Loss cap for the anchor wallet

The anchor signer's gas wallet is the **only path by which funds leave** this system.
The cap holds only when there are two of them.

| Cap | What it limits | Where it lives |
|---|---|---|
| Funding cap | Total held in the wallet. A leaked key loses at most this much | Finance and operations procedure. Code cannot enforce it |
| Spend cap | Daily admission budget, counting actual receipts and open reservations. On opBNB the L1 reservation is an estimate, so actual spend can exceed it | `ANCHOR_DAILY_SPEND_CAP_WEI` |

With only a funding cap, the whole balance can burn in one day. With only a spend cap,
the entire balance held in the wallet is exposed.

On opBNB, twice the oracle's L1 quote is a margin, **not an enforceable fee ceiling**: if the
quote is X and inclusion costs 3X, reserving 2X undercounts that send. The transaction signs no
maximum L1 data fee. Hold at most the intended loss budget in the signer wallet, and disable
automatic refills. Replenish only after reconciling actual receipts and outstanding sends;
repeated refills while sends are pending defeat that funding limit. This is an operations
requirement, not a guarantee the worker can enforce against other wallet funding.

### Choosing the values

```
expected spend (wei) = submissions per day × (gas per submission × ANCHOR_FEE_CAP_GWEI × 1e9
                                              + L1 data fee per submission)
daily spend cap      = expected spend × 1.5
funding cap          = daily spend cap (hold only one day's worth)
```

- **Gas per submission** — the `submitRoot` max from `forge test --gas-report`, plus the
  base transaction cost (21,000) and a calldata margin. Measured on 2026-08-26: `submitRoot`
  median 128,082, max 145,926; the calculation uses **170,000 gas per submission**.
- **Submissions per day** — a fact of the production environment. The repository does
  not set it. Batching collects publications and submits them together, so submissions
  are **fewer** than publications.
- **Gas price cap** — `ANCHOR_FEE_CAP_GWEI` (default 100). Above this value the worker
  does not submit, so this value is exactly the worst case. Changing only one of the two
  moves the cap off its intended multiple.
- **L1 data fee per submission** — 0 on BSC (56) and anvil (31337). On opBNB (5611) every
  transaction also pays for posting it to BSC, outside the gas price: the receipt's `l1Fee`.
  `ANCHOR_FEE_CAP_GWEI` does not bound it. Use twice the GasPriceOracle quote the worker reserves
  (below); measured on 2026-10-29 on opBNB testnet, the quote for a `submitRoot` was
  1.09 × 10^10 wei, about 7% of its execution cost at 0.001 gwei.

Set `ANCHOR_DAILY_SPEND_CAP_WEI` as an **integer in wei**. Notations such as `0.05` or
`1e17` are rejected. **There is no default** — starting with it empty makes the anchor
worker refuse to run. A default would let a deployment ship with no one having chosen a cap.

`apps/anchor-worker/test/anchor-config.test.ts` re-checks the multiplication.

Record the chosen value and its basis (what the submissions-per-day figure was taken from) in
the operations log. A value set without its basis cannot later answer why that number.

### What the code does

`checkSubmitAllowed` in `apps/anchor-worker/src/anchor-state.ts` checks three things right before
a submission.

1. `DAILY_SPEND_CAP_REACHED` — blocks when this submission could carry the day past the cap:

   ```
   spent today (UTC, receipts in chain.gas_spend: gas_used × effective_gas_price + l1_fee)
     + Σ open sends: gas_limit × max_fee_per_gas + l1_fee_bound      (chain.anchor_sends)
     + open sends without a gas limit × block gas limit × ANCHOR_FEE_CAP_GWEI × 1e9
     + ANCHOR_GAS_LIMIT × min(quoted max fee, ANCHOR_FEE_CAP_GWEI × 1e9) + this send's L1 bound
     > ANCHOR_DAILY_SPEND_CAP_WEI
   ```

   The L1 terms are 0 except on opBNB. There a receipt's `l1Fee` is recorded as `l1_fee`, and a
   send in flight reserves `l1_fee_bound`: the `GasPriceOracle.getL1Fee` quote (predeploy
   `0x420000000000000000000000000000000000000F`) for the transaction about to be signed, × 2. A
   failed quote, or an opBNB receipt without `l1Fee`, leaves the row waiting with a recorded
   reason (`l1_fee_estimate_failed`) or the send open — never counted at gas alone.

   Before broadcasting an EOA send with a nonzero L1 reservation, remaining daily headroom
   must fit its configured gas ceiling plus current L1 reservation and one extra retry slot:

   ```
   candidate = ANCHOR_GAS_LIMIT × ANCHOR_FEE_CAP_GWEI × 1e9 + current L1 reservation
   spent today + all open reservations + candidate
     + max(0, candidate - matching existing reservation) <= ANCHOR_DAILY_SPEND_CAP_WEI
   ```

   A matching reservation is a live, unreceipted ledger entry for the same chain, transaction,
   signer and nonce as the prepared send. It can satisfy the extra retry slot only; it stays
   fully counted among all open reservations. Settled entries and other transactions, signers
   or nonces grant no credit. Signing locally supplies this identity under the chain spend lock;
   `DAILY_SPEND_CAP_TOO_LOW_FOR_RETRY` then leaves the row waiting without broadcast, a new ledger
   reservation or a consumed attempt. The ordinary one-send spend, gas-price and attempt checks
   run first, before signing, and retain their existing reason priority.

   Startup checks only the gas terms because the L1 quote is live. The final check leaves room
   at the current quote for an initial failed broadcast and a replacement using its free nonce;
   it neither releases an uncertain send nor guarantees retry room after fees rise or other
   sends consume headroom. Review the funding limit before increasing the budget, or wait for
   headroom or a lower quote. Safe proposals bypass this check because owners pay execution fees.

   Every send is signed first and written to `chain.anchor_sends` (hash, signer, nonce, gas
   limit, max fee) **before** it is broadcast, and stays open — counted at its reservation — until it
   is settled by evidence only:

   - `receipt` — its receipt is recorded in `chain.gas_spend` at its actual cost;
   - `nonce_consumed` — the signer's nonce at a block `ANCHOR_CONFIRMATIONS` deep, and at or below
     the `ANCHOR_FINALITY_TAG` head, is past this send's nonce and the send has no receipt: another
     transaction took the nonce.

   Neither time nor the state of the `chain.transactions` row settles a send. A dropped row, or
   one reset by a resubmission, keeps counting until one of the two above holds; a failed
   lookup leaves it open — only the node's "not found" answer counts as "no receipt"; any other
   failure of the receipt or transaction lookup keeps the send open. Every send carries `ANCHOR_GAS_LIMIT` (default 200,000) as its gas
   limit. The check and the send run under a per-chain advisory lock, so several workers cannot
   spend the same headroom.

   Sends carried over by migration 0079 recorded no gas limit or nonce; they count at the block
   gas limit until their receipt arrives. One that will never be mined (dropped before the
   ledger existed) can only be settled by hand, after checking the signer's nonce on chain:

   ```sql
   UPDATE chain.anchor_sends SET settled_at = now(), settled_reason = 'operator'
   WHERE chain_id = <chain> AND tx_hash = '<hash>' AND settled_at IS NULL;
   ```

2. `FEE_ABOVE_CAP` — blocks when this submission's gas price exceeds `ANCHOR_FEE_CAP_GWEI`
3. `MAX_ATTEMPTS_REACHED` — the same batch is not resubmitted more than `ANCHOR_MAX_ATTEMPTS` times

**The daily cap is checked before the gas cap.** When both apply, the reason left behind must be
the loss cap — `FEE_ABOVE_CAP` clears when fees drop, but the daily cap clears only when the
date changes.

### What this cap does not count

- **Submissions whose receipt has not arrived yet — at their actual cost.** They retain their
  reservations (above) until settled. On opBNB the L1 part is an estimate with a
  2× margin, not a ceiling the transaction signs: the fee follows the L1 base fee when the block
  is built, so an L1 gas spike beyond the margin can make one send cost more than was reserved.
  Startup requires room for two sends' gas at the fee cap; before an EOA send with an L1 fee,
  the live retry minimum above adds two L1 reservations too. A broadcast that failed stays open
  until its nonce is consumed, and with room for only one send, its replacement cannot go out.
- **Signer key rotation.** Sends of the old key stay open until that key's nonce is taken at
  depth or their receipt arrives; a new key never takes an old key's nonce. An old send that
  will never be mined is settled by hand (above), after checking the old key's nonce on chain.
- **A send lost between broadcast and the ledger** cannot happen: the ledger row is committed
  first. The reverse — a ledger row whose broadcast never left — stays open until its nonce is
  reused.
- **Gas burned by attempts reverted by a reorg.** Only the last receipt remains on the row.
- **The multisig proposal path.** Proposals do not spend this wallet's gas. Multisig
  owners execute them, and the loss cap on that side is the owner set and the threshold.

Because some things go uncounted, **the funding cap is the last line of defense**.

The day boundary is **UTC midnight**. Following the server timezone would silently shift
the time the cap resets whenever the deployment location changes.

### When it blocks

Rows with `chain.transactions.last_error` = `DAILY_SPEND_CAP_REACHED` accumulate. Their state
stays `created` and the batch does not disappear. After UTC midnight, the next loop proceeds.

If the cap needs raising, redo the calculation above, record the basis, then change the value.
Do not raise it just because it blocked — that cap is all of O1.

## opBNB testnet (dev)

The dev deployment runs on opBNB testnet: `CHAIN_ID=5611` for the API, anchor worker and the
other services that read it (RPC `https://opbnb-testnet-rpc.bnbchain.org`, explorer
`https://testnet.opbnbscan.com`, gas paid in tBNB). The web app links transactions to that
explorer and offers the chain to wallets that lack it.

- **First operator.** `pnpm --filter @mpc/api bootstrap` binds the wallet on `BOOTSTRAP_CHAIN_ID`,
  which defaults to `CHAIN_ID`; set either to 5611, or the wallet lands on 31337 and cannot log in.
- **Scan service identity.** Bind `SCAN_SERVICE_ADDRESS` the same way, in the same tenant, with
  `BOOTSTRAP_ROLE=scan_service`. Without it the scan worker's results are rejected and uploads
  stay quarantined.
- **Earlier anchors keep their chain and contract.** Public proofs and hash search report the
  chain and the anchor contract each transaction was stored with (`chainId`, `contractAddress`),
  so anchors made before a chain change or a new contract version still point at the contract
  that holds their root. The worker records the contract with the hash; an anchor recorded
  before it did reports `contractAddress: null`, never the currently configured contract. Both
  are null until the transaction has a hash.
- **Moving chains drains the old one first.** A worker picks only its own `CHAIN_ID`'s rows, so
  after a change nothing settles the old chain's created, proposed, submitted or included
  transactions, and their proofs stay unconfirmed. Nor does anything settle its open sends —
  even those of a failed transaction — so a later receipt never reaches the gas ledger. The new
  worker logs `anchor.other_chain_in_flight` with both counts per chain (`inFlight`,
  `openSends`) at startup and then at most once a minute, busy or idle; keep (or start) a worker
  with the old `CHAIN_ID` until both reach zero. A worker stores each confirmed row's reorg-watch
  deadline (`reorg_watch_until`, its confirmation time plus its `ANCHOR_REORG_WATCH_MS`), rechecks
  the row until then, and the warning counts it until then too. A worker also rechecks rows for
  at least its own `ANCHOR_REORG_WATCH_MS` after confirmation, so raising it applies to that worker
  at once; within a minute (and on every replica, also during a rolling deploy) it extends the
  stored deadlines of rows still inside its watch (`anchor.reorg_watch.extended` logs how many),
  so the warning follows. A failed extension is logged (`anchor.reorg_watch.extend_failed`) and
  retried a minute later without stopping anchoring. Lowering it never shortens a stored
  deadline: it applies to rows confirmed afterwards.
  Rows confirmed before stored deadlines existed have none: their worker watches them for its
  current `ANCHOR_REORG_WATCH_MS` after confirmation, and the warning counts them for at least
  24 hours after confirmation (longer if this worker's `ANCHOR_REORG_WATCH_MS` is), so it may last
  longer than needed, never too short.
  To move a stuck old-chain batch, resubmit it from the new deployment. That only *requests* the
  move (migration 0105, `move_to_chain_id`; audit reason `chain_move_requested` with
  `fromChainId`/`toChainId`; the anchors screen shows "Move to chain … requested"): the row keeps
  its old `chain_id`, state and hash until **the old chain's worker** carries it out, because only
  the old contract can say whether the batch is already there — any holder of its submitter role
  (the Safe, another signer) could have stored it without a trace in the database. So keep a
  worker with the old `CHAIN_ID` running until the request is gone. That worker waits while any
  send or Safe proposal of the row, or any transaction of its signer, is still open on the old
  chain, then reads the batch from the old contract: absent, it resets the row onto the new chain
  (audit `anchor.batch.chain_moved`), whose worker sends it like a new batch; present, it drops
  the request and reconciles the row with what the chain holds (audit
  `anchor.batch.chain_move_refused`; the anchors screen shows "Move … refused" until someone
  resubmits again). While it waits, the screen shows what for (`moveRequest.waitReason`: an open
  send or Safe proposal, an unmined signer transaction, or a failed read), or that the old
  chain's worker has not looked yet (`lastCheckedAt` null — check that it is running). Do not
  submit anchors by hand or through the Safe on the old chain while a move is requested: a
  submission after the worker's check would anchor the root on both chains. Grant the submitter
  role on each contract only to that chain's worker signer (`ANCHOR_SUBMITTER`), or to the Safe on
  Safe-path chains, so no other party can submit at all. The worker checks every contract in
  `chain.anchor_contracts` (0107: every contract a row, a proposal or a worker's configuration
  has used on that chain). Before requesting a move, make sure every contract ever configured
  for the old chain is there — rows from before contracts were recorded, or reset since, may have
  left none behind — and add any missing one by hand (`INSERT INTO chain.anchor_contracts
  (chain_id, contract_address)`, lowercase; the deployment records in `testnet-contract.md` /
  `mainnet-contract.md` list them). An address without code is skipped; a contract whose
  `getBatch` fails keeps every move on that chain waiting (`check_failed`). The table is
  append-only: removing a wrong entry needs the table owner to disable
  `anchor_contracts_no_delete` for that statement. A resubmit on the row's own chain
  withdraws a pending request, and a request for a third chain replaces it (the audit records the
  replaced target). The request is refused with `ANCHOR_CHAIN_MOVE_BLOCKED` when the batch already
  has another transaction (`reason: other_transaction`), or when the two chains are not of the
  same environment (`reason: cross_environment`: BSC mainnet 56 against a test chain, or a chain
  outside the supported list).
- **EOA submission is opt-in.** Set `ANCHOR_EOA_CHAIN_IDS=5611` for the worker to sign alone;
  without it the default (`31337`) leaves 5611 on the Safe proposal path, or blocked when no Safe
  is configured. Listing 56 refuses startup — mainnet stays Safe-only whatever is set.
- **Keys and endpoint.** Generate fresh signer and scan-service keys: the anvil/hardhat defaults
  and the keys committed in this repository are refused on any chain but 31337. The worker also
  refuses to start unless `CHAIN_RPC_URL` reports chain 5611, `ANCHOR_CONTRACT_ADDRESS` holds
  contract code there, and the endpoint answers the `ANCHOR_FINALITY_TAG` block tag.
- **Fee cap.** Gas price was observed around 0.001 gwei, so `ANCHOR_FEE_CAP_GWEI=1` is ample and
  keeps the worst case small.
- **Spend cap.** Size it with the formula above at that fee cap, including the L1 data fee: it
  follows BSC's gas price, so neither the fee cap nor the gas limit bounds it. It cannot be below
  `2 × ANCHOR_GAS_LIMIT × ANCHOR_FEE_CAP_GWEI × 1e9` — 400,000,000,000,000 wei (0.0004 tBNB)
  with the default gas limit and a 1 gwei cap; that floor leaves the L1 fee out, since it is
  only known per send. Hold only that day's worth in the signer wallet.
- **Confirmations.** Set `ANCHOR_CONFIRMATIONS=12` (the code default) explicitly — `.env.example`
  sets 2 for anvil, so a copied file would lower it. Staging must use the production value so
  reorg handling is exercised (threat model T8).
- **Finality tag.** opBNB blocks are 0.25 s, so 12 confirmations are 3 s — no protection from a
  sequencer reorg. `ANCHOR_FINALITY_TAG` (default `safe` on 5611 and 56, `none` on 31337) also
  holds a receipt as `included` until its block is at or below the node's `safe` head — blocks
  whose batch is posted on BSC; it trailed the head by ~50 blocks (~13 s) when measured.
  `finalized` waits longer; `none` falls back to depth alone. Any other value refuses startup.
  The worker refuses to start when the endpoint does not answer the tag. If a later read of it
  fails, the row keeps its current state (`submitted`, `included`, or `confirmed` on a reorg-watch
  recheck) with `last_error = finality_read_failed` rather than confirming on depth.
  Open-send receipt checks still record actual costs during head, finality-tag or nonce RPC
  failures; only settlement based on a consumed nonce waits for safe nonce evidence.
- **Log lookback.** When the chain holds a batch the worker has no hash for (a lost send result,
  a resubmission), it looks for the `RootSubmitted` log back to the block the batch was stored
  in, in 5,000-block `eth_getLogs` ranges, up to `ANCHOR_LOG_LOOKBACK_BLOCKS` (default: a day of
  blocks — 345,600 on opBNB). Only a completed search that finds nothing means
  `reconciliation_required`, never a second send. A failed or rate-limited read, or a node whose
  head is not yet past the block that stored the batch (a lagging node behind a load balancer),
  keeps the row as it is with `last_error` `reconciliation_check_failed` (before a send),
  `duplicate_check_failed` (after a reverted send) or `anchored_elsewhere_check_failed` (after a
  receipt without the root). That row is not picked again for `ANCHOR_CHAIN_SEARCH_RETRY_MS`
  (default 60,000 ms), so later rows on the chain keep moving. If searches for it keep failing
  for `ANCHOR_CHAIN_SEARCH_GIVE_UP_MS` (default 3,600,000 ms, counted from the first failure; a
  search that answers starts it again), it becomes `reconciliation_required` with
  `last_error = chain_search_unavailable` and raises `anchor.needs_attention` — typically an
  endpoint whose `eth_getLogs` range limit is below 5,000 blocks, which has pruned the history,
  or which stays rate-limited. Confirmed rows with an unresolved search remain eligible beyond
  the ordinary reorg watch until recovery or give-up, respecting retry and recheck delays.
  A successful search or valid receipt ends the consecutive search-failure period. If finality
  is still unavailable, an independent `retry_after` schedule keeps the row eligible without
  retaining an old search-failure start. Completed tracking clears that schedule, so an expired
  watch then stops normally. Terminal transitions and manual resubmission reset both timers.
  Point `CHAIN_RPC_URL` at one that serves the range, then resubmit.
- **Receipts must show the root.** A successful receipt confirms only if it carries
  `RootSubmitted` for that batch and root from the contract recorded with the transaction's hash
  (the configured one only for rows recorded before the contract was stored). Otherwise — a Safe
  execution whose inner call failed — the row follows another transaction that stored the batch
  on that contract, or becomes
  `reconciliation_required` with `last_error = receipt_without_root_submitted`.

Testnet roots prove nothing anyone relies on; do not reuse its keys or contract on mainnet.

## Edge proxy path — web app on a CDN, API on its own host

The default layout puts `web` and `api` on one private network: `web` proxies `/api/*` and
the API trusts `x-forwarded-for` from that peer because it is inside `TRUSTED_PROXY_CIDRS`.
When the web app runs on a CDN (Vercel or similar), three things stop holding, and each has a
setting.

| Problem | Setting | Where |
|---|---|---|
| The CDN's egress addresses are not fixed, so no range can name the peer; every visitor becomes the CDN and the sign-in cap (`AUTH_RATE_LIMIT_MAX`) is shared by the whole site | `EDGE_PROXY_SECRET` — the same value on both sides. The web proxy attaches it with the visitor address it saw; the API uses that address only when the secret matches. Minimum 32 characters; generate it, never reuse another secret. Set it only behind a platform that overwrites `x-real-ip` and `x-forwarded-for` with the address it saw (Vercel does); in front of anything that passes a visitor's own `x-real-ip` through, the visitor picks its address and every forged one gets its own cap | web **and** API |
| The CDN cuts a proxied request at its own time cap (Vercel: 120 s), which a large evidence upload does not fit in | `NEXT_PUBLIC_API_DIRECT_ORIGIN` (web, build time) — the API host the browser posts the streaming upload route to directly. `EDGE_WEB_ORIGIN` (API) — the one origin admitted on that route. Nothing else is opened cross-origin | web (build) · API |
| `/health/*` and `/metrics` carry no auth; an API host reachable from the internet would expose readiness and the operational gauges | `OPS_ENDPOINT_CIDRS` — socket peers allowed on those paths, default the private ranges. Anyone else gets the 404 of an unknown path. List the collector's and the orchestrator's ranges | API |

Values that change with the public address, as before: `SIWE_DOMAIN`, `SIWE_URI`,
`API_ORIGIN` (web, run time).

What to confirm after the first deployment: sign in twice from two networks and check the
API log does not report the requester as unroutable; upload a file above the base64 cap and
confirm the browser request went to `NEXT_PUBLIC_API_DIRECT_ORIGIN`; request `/health/ready`
from outside and receive 404.

**This is a staging layout.** The rules on production deployment in the repository root
README are unchanged by these settings.

## Observability

```sh
docker compose -f docker/docker-compose.yml --profile observability up -d
```

Prometheus is on `:9090` and Alertmanager on `:9093`. **By default neither port is
exposed externally** — `/metrics` has no authentication (and in exchange carries no
identifying information), so the network forms the boundary. Alert receivers are not
kept in the repository. Adding them would make them a secret, and they would stay in
the commit history even after removal.

The configuration is checked with the official `amtool` from the same image used in
deployment — `scripts/ops/check-alertmanager.sh`.

## Independent workers

| Service | App | Runtime access |
|---|---|---|
| `jobs-worker` | `apps/jobs-worker` | Worker DB and configured webhook signing references |
| `anchor-worker` | `apps/anchor-worker` | Worker DB, chain RPC and anchor signing key |
| `scan-worker` | `apps/scan-worker` | Worker DB, quarantine storage, scanner connection and scan service identity |

Build the worker and scanner images from the same repository revision:

```sh
docker compose -f docker/docker-compose.yml build jobs-worker anchor-worker scan-worker clamav
docker compose -f docker/docker-compose.yml up -d jobs-worker anchor-worker scan-worker clamav
```

`docker/Dockerfile.workers` selects an app with `WORKER` and uses `pnpm deploy --prod --legacy`
to package only that app and its production dependencies, including the TS runtime. Worker
images do not contain the web app or other worker apps. API and web keep `docker/Dockerfile`.

`docker/Dockerfile.clamav` builds a separate scanner image. Only the scan worker and
ClamAV join the internal scan network; the scanner has an additional network for signature
updates, separate from the application network. No scanner port is published on the host.
The worker sends file bytes through INSTREAM to `clamav:3310`. The scanner receives no DB,
object-store or scan-service credentials, application files, or worker secret mounts. A parser
exploit therefore does not directly expose the worker's credentials through a shared process
or filesystem. Keep this separation when overriding the Compose configuration.

Signature updates use `clamavdata`, retaining downloaded definitions across restarts. The
first start downloads signatures before the scanner becomes ready. Compose starts the worker
after scanner readiness. The worker also probes readiness before claiming uploads, pausing
during outages without consuming their attempt budgets. A connection failure racing that
probe refunds only the attempt belonging to the same lease. Once a connection accepts the
file, failures remain bounded so a parser-crashing file cannot retry forever. Every error
keeps the upload quarantined. Monitor exhausted retries as well as scanner availability.

Multipart uploads accept at most **2000 MiB** (2,097,152,000 bytes), matching ClamAV's
configured `2000M` limits. This corrects the previous 2 GiB API allowance, which exceeded
what the configured scanner could inspect by 48 MiB. Larger files must be reduced or split;
existing oversized quarantined uploads are not automatically approved or marked infected.
The scan deadline is one absolute budget: `SCAN_TIMEOUT_MS` (30 seconds by default)
plus 125 ms per MiB, capped at 10 minutes. Both socket inactivity and the absolute deadline
use that budget. The default maximum accepted file receives 280 seconds. Upload leases
cover a bounded 60-second object read, that scan budget, and 120 seconds for API reporting;
the read deadline aborts the S3 request and response body, and the worker waits for cleanup
before releasing its lease or starting another attempt. Custom object stores must likewise
honor the optional abort signal and settle only after their read resources are closed.
`SCAN_LEASE_MS` remains a minimum, so a large file receives at least 460 seconds.
The client honors socket backpressure instead of queuing a second full upload in memory.
The scan worker has a 480-second Compose shutdown grace period so an accepted maximum-size
job can finish. If increasing `SCAN_TIMEOUT_MS` or `SCAN_LEASE_MS`, increase that grace period
to cover the configured full read/scan/report cycle; unrelated workers retain their own limits.

The worker performs bounded PING checks and refreshes availability every 15 seconds while
an absolute-bounded scan is active. A stuck database lease/query still becomes stale. A fresh worker heartbeat with an unavailable daemon is shown as `unavailable`,
not `running`; old heartbeat formats without scanner availability are `unknown` until upgraded.
For a maximum-size manual drill, set `LARGE_SCAN_MIB=2000` when running
`scripts/ops/test-scan-worker-image.sh`; the default remains a 300 MiB disk-spool check.

ClamAV spools INSTREAM input and extracted content into the disk-backed `clamavscratch`
volume at `/var/tmp/clamav`, separately from signatures. The directory is writable only by
the scanner user; its root filesystem stays read-only and `/tmp` stays a 256 MiB tmpfs.
Large scans require free host disk space. Scratch can contain quarantined evidence bytes;
exclude it from backups. Normal scans remove temporary files, but interrupted scans may leave
files behind. Stop ClamAV before removing its scratch volume when disposing of local evidence.
Do not remove the signature volume just to clear scratch. Existing scanner limits still apply.

When running the TypeScript worker directly, provide a reachable ClamAV daemon;
`CLAMAV_HOST` and `CLAMAV_PORT` default to `127.0.0.1` and `3310`.
The scanner entrypoint supervises `clamd` and the signature updater, exiting if either dies.
Its health check requires a scanner ping; the worker has its own heartbeat health check.
The worker caps scanner responses at 4 KiB and enforces a total scan deadline, treating
oversized, malformed or late responses as errors.

Rebuild and recreate both services when upgrading from the combined image:

```sh
docker compose -f docker/docker-compose.yml up -d --build --remove-orphans
```

Compose provides an init process, a read-only filesystem, writable `/tmp`, and a 60-second
shutdown grace period. Each loop refreshes its own health file after recording its DB heartbeat,
so a healthy replica cannot mask a stalled container. Idle loops are healthy; missing or stale
files are unhealthy. Compose does not automatically restart an unhealthy running container;
`restart: unless-stopped` restarts exited processes. Monitor health and the existing backlog alerts.

Jobs retains the `outbox` heartbeat kind for existing metrics and alerts. When upgrading an
existing local stack, remove its old `outbox-worker` container so it does not run beside jobs.
Update external service-name references to `jobs-worker`. Local Compose remains a demo stack;
production hostnames and credentials are supplied separately.
