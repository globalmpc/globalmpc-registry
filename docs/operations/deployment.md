# Deployment configuration

The local stack is defined in `docker/docker-compose.yml`. Docker image definitions live alongside it in `docker/`;
service configuration and database setup live beside the responsibilities they support.
Production values (hosts, domains, credentials, actual caps) never enter the repository.
Run the commands in this guide from the repository root.

| Path (from repository root) | Contents |
|---|---|
| [`docker/Dockerfile`](../../docker/Dockerfile) | API and web image |
| [`docker/Dockerfile.workers`](../../docker/Dockerfile.workers) | Independent worker images |
| [`docker/scan-worker/`](../../docker/scan-worker/) | Embedded ClamAV configuration and scan-worker process supervision |
| [`packages/db/sql/login-roles.sql`](../../packages/db/sql/login-roles.sql) | Login roles subject to RLS, so the app never runs as superuser |
| [`config/local-secrets/`](../../config/local-secrets/) | **Public defaults, local use only.** See its README for why |
| [`config/observability/`](../../config/observability/) | Prometheus scrape configuration, alert rules and Alertmanager configuration |
| [Backup and restore](backup-restore.md) | What the backup, restore and drill scripts capture, refuse and verify |
| [Release rollback](rollback.md) | Compatibility checks and the release rollback procedure |
| [Mainnet contract](mainnet-contract.md) | Contract deployment procedure for mainnet (56) and what must be settled first |

## Secret injection

Environment variables carry a **reference**, not the value (`file:/run/secrets/...` · `env:NAME`).
No secret remains in the process environment or in `docker inspect`, and local and
deployed environments read through the same code path (`packages/config`). In a real
deployment, Docker secrets, Kubernetes projected volumes, or a secret manager place the
file at the same location.

**Notification webhook signing secrets** are references too, but only inside a namespace
that holds nothing else: `env:WEBHOOK_SECRET_<NAME>` (`NAME` is `[A-Z0-9_]`, 1–64 characters)
or `file:/run/secrets/webhook_<name>` (`name` is `[A-Za-z0-9_-]`, 1–64 characters, no
subdirectories). The API refuses any other reference when a sink is registered, and the
worker refuses it again before reading — so a sink cannot point the worker at its database
URL or the signer key. Provision each tenant's signing secret under one of those names
(for Docker secrets, name the secret `webhook_<name>`).

## Loss cap for the anchor wallet

The anchor signer's gas wallet is the **only path by which funds leave** this system.
The cap holds only when there are two of them.

| Cap | What it limits | Where it lives |
|---|---|---|
| Funding cap | Total held in the wallet. A leaked key loses at most this much | Finance and operations procedure. Code cannot enforce it |
| Spend cap | Total burned per day. The worker cannot drain the wallet on its own | `ANCHOR_DAILY_SPEND_CAP_WEI` |

With only a funding cap, the whole balance can burn in one day. With only a spend cap,
the entire balance held in the wallet is exposed.

### Choosing the values

```
expected spend (wei) = submissions per day × gas per submission × ANCHOR_FEE_CAP_GWEI × 1e9
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
   spent today (UTC, receipts in chain.gas_spend)
     + Σ open sends: gas_limit × max_fee_per_gas      (chain.anchor_sends)
     + open sends without a gas limit × block gas limit × ANCHOR_FEE_CAP_GWEI × 1e9
     + ANCHOR_GAS_LIMIT × min(quoted max fee, ANCHOR_FEE_CAP_GWEI × 1e9)
     > ANCHOR_DAILY_SPEND_CAP_WEI
   ```

   Every send is signed first and written to `chain.anchor_sends` (hash, signer, nonce, gas
   limit, max fee) **before** it is broadcast, and stays open — counted at its most — until it
   is settled by evidence only:

   - `receipt` — its receipt is recorded in `chain.gas_spend` at its actual cost;
   - `nonce_consumed` — the signer's nonce at a block `ANCHOR_CONFIRMATIONS` deep is past this
     send's nonce and the send has no receipt: another transaction took the nonce.

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

- **Submissions whose receipt has not arrived yet — at their actual cost.** They are reserved at
  their most (above) until settled. The cap must fit at least two sends at the fee cap
  (`2 × ANCHOR_GAS_LIMIT × ANCHOR_FEE_CAP_GWEI × 1e9`) — the worker refuses to start below it:
  a broadcast that failed stays open until the next send reuses its nonce, and with room for
  only one, that next send never goes out.
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
| `scan-worker` | `apps/scan-worker` | Worker DB, quarantine storage, embedded ClamAV and scan service identity |

Build the three images from the same repository revision and lockfile:

```sh
docker compose -f docker/docker-compose.yml build jobs-worker anchor-worker scan-worker
docker compose -f docker/docker-compose.yml up -d jobs-worker anchor-worker scan-worker
```

`docker/Dockerfile.workers` selects an app with `WORKER` and uses `pnpm deploy --prod --legacy`
to package only that app and its production dependencies, including the TS runtime. Worker
images do not contain the web app or other worker apps. API and web keep `docker/Dockerfile`.

The scan image also installs ClamAV. Its `clamd` daemon listens only on `127.0.0.1:3310`
inside the scan-worker container; there is no separate ClamAV service or published scanner
port. The worker still sends file bytes through INSTREAM. Signature updates use the
`clamavdata` volume so restarts retain downloaded definitions. The first start downloads
signatures before scanning can begin; uploads remain quarantined while the scanner starts.
ClamAV spools INSTREAM input and extracted content into the disk-backed `clamavscratch`
volume at `/var/tmp/clamav`, separately from signatures. The directory is writable only by
the runtime user; the container root filesystem stays read-only and `/tmp` stays a 256 MiB
tmpfs. Large scans therefore need free host disk space, rather than that small tmpfs.
Scratch can contain quarantined evidence bytes; exclude this disposable volume from backups.
Normal scans remove temporary files, but
an interrupted daemon can leave files behind; after stopping the scan worker, remove its
scratch volume when disposing of local evidence. Do not remove the signatures volume just
to clear scratch. Existing scanner size and extraction limits still apply.
When running the TypeScript process directly, provide a local ClamAV daemon; `CLAMAV_HOST`
and `CLAMAV_PORT` default to `127.0.0.1` and `3310`.
The entrypoint waits for a scanner ping before starting the worker, supervises the worker,
scanner and signature updater together, and exits the container if any process dies.
The scan health check requires both a fresh worker heartbeat and a successful scanner ping.

When upgrading an existing stack, rebuild and remove the former standalone ClamAV container
with Compose orphan cleanup:

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
