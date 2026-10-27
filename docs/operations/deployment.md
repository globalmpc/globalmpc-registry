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
| [`packages/db/sql/login-roles.sql`](../../packages/db/sql/login-roles.sql) | Login roles subject to RLS, so the app never runs as superuser |
| [`config/local-secrets/`](../../config/local-secrets/) | Optional public fixtures for file-reference configuration; not mounted by Compose |
| [`config/observability/`](../../config/observability/) | Prometheus scrape configuration, alert rules and Alertmanager configuration |
| [Backup and restore](backup-restore.md) | What the backup, restore and drill scripts capture, refuse and verify |
| [Release rollback](rollback.md) | Compatibility checks and the release rollback procedure |
| [Mainnet contract](mainnet-contract.md) | Contract deployment procedure for mainnet (56) and what must be settled first |

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
