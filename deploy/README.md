# Deployment configuration

This directory holds what `docker-compose.yml` needs to bring up the local stack.
Production values (hosts, domains, credentials, actual caps) never enter the repository.

| Path | Contents |
|---|---|
| `clamav/` | ClamAV image used by the scan worker. Built here because the official image is amd64-only |
| `sql/login-roles.sql` | Login roles subject to RLS. Exists so the app never runs as superuser |
| `local-secrets/` | **Public defaults, local use only.** See `README.md` in that directory for why |
| `observability/*.yml` | Prometheus scrape configuration and alert rules |

## Secret injection

Environment variables carry a **reference**, not the value (`file:/run/secrets/...` · `env:NAME`).
No secret remains in the process environment or in `docker inspect`, and local and
deployed environments read through the same code path (`packages/config`). In a real
deployment, Docker secrets, Kubernetes projected volumes, or a secret manager place the
file at the same location.

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
  base transaction cost (21,000) and a calldata margin.
- **Submissions per day** — a fact of the production environment. The repository does
  not set it. Batching collects publications and submits them together, so submissions
  are **fewer** than publications.
- **Gas price cap** — `ANCHOR_FEE_CAP_GWEI` (default 100). Above this value the worker
  does not submit, so this value is exactly the worst case. Changing only one of the two
  moves the cap off its intended multiple.

Set `ANCHOR_DAILY_SPEND_CAP_WEI` as an **integer in wei**. Notations such as `0.05` or
`1e17` are rejected. **There is no default** — starting with it empty makes the anchor
worker refuse to run. A default would let a deployment ship with no one having chosen a cap.

`apps/worker/test/anchor-config.test.ts` re-checks the multiplication.

### What this cap does not count

- **Submissions whose receipt has not arrived yet.** The actual cost is known only once
  the transaction is in a block. Exposure in that window is bounded by
  `ANCHOR_FEE_CAP_GWEI × ANCHOR_MAX_ATTEMPTS`.
- **Gas burned by attempts reverted by a reorg.** Only the last receipt remains on the row.
- **The multisig proposal path.** Proposals do not spend this wallet's gas. Multisig
  owners execute them, and the loss cap on that side is the owner set and the threshold.

Because some things go uncounted, **the funding cap is the last line of defense**.

The day boundary is **UTC midnight**. Following the server timezone would silently shift
the time the cap resets whenever the deployment location changes.

## Observability

```sh
docker compose --profile observability up -d
```

Prometheus is on `:9090` and Alertmanager on `:9093`. **By default neither port is
exposed externally** — `/metrics` has no authentication (and in exchange carries no
identifying information), so the network forms the boundary. Alert receivers are not
kept in the repository. Adding them would make them a secret, and they would stay in
the commit history even after removal.

The configuration is checked with the official `amtool` from the same image used in
deployment — `scripts/ops/check-alertmanager.sh`.
