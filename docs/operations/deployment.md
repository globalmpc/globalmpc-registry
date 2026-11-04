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
| `SCAN_SERVICE_TOKEN` | `SCAN_SERVICE_TOKEN` | Scan worker only (default: the value `scan-token` generates; see [Service tokens](#service-tokens)) |

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

- **bootstrap and service-token ensure** require ownership (or an inherited owner role) of
  `core.tenants`, `core.subjects`, and `core.service_tokens`. Application/worker logins are
  rejected. Resolve/create the tenant inside the transaction, then set `app.current_tenant`
  before account/token access. FORCE RLS remains enabled; global UNIQUE constraints reject
  hidden email/token collisions and roll back all new rows. BYPASSRLS is not required for
  these deployment steps. Apply migration 0136 before running the updated CLI.
- **The role that runs the migrations owns the `SECURITY DEFINER` functions**, and it too needs
  superuser or `BYPASSRLS`. Many of them read outside the caller's tenant by design — sign-in
  before a tenant is known, an address or identity that must be free in every tenant, token and
  state lookups (including session and service-token resolution and the role bindings read with
  them), purges and gauges, a wallet's disable history (the list is in
  `0131_cross_tenant_definers_fail_closed.sql`). They run with `row_security = off` (0130, 0131):
  under an owner that does not bypass RLS they fail with "query would be affected by row-level
  security policy" instead of seeing zero rows and answering "nothing there". Every authenticated
  request, sign-in, invitations, email changes, OIDC and wallet binding would all fail at the first
  use. This remains a separate runtime requirement: making bootstrap tenant-scoped does not
  establish that an Aurora deployment can sign in. Verify the effective function owners and
  actual sign-in/session resolution before release; Aurora's `rds_superuser` is not PostgreSQL
  superuser. This change does not grant any role BYPASSRLS or relax these fail-closed functions.
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
ends. The corrected 0107 and repair migration 0134 install contract-history triggers and backfill
in one transaction, locking `chain.transactions` and `chain.anchor_proposals` against writes
for the whole operation. 0107 also locks the durable `chain.anchor_batches` history while proving
an empty deployment.
A role that is neither superuser nor `BYPASSRLS` also locks readers while
lifting FORCE RLS for the backfill. Every lock wait is bounded to 5 seconds; a timeout rolls back
the migration, which remains unrecorded and can be retried once conflicting transactions end.
An old partial, unrecorded 0107 installation can be retried safely. Look first, and end or wait
out what you find:

```sql
SELECT pid, usename, application_name, state, now() - xact_start AS open_for
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
ORDER BY xact_start;
```

Run `migrate` before starting workers of a new release: from 0107 the anchor worker registers its
configured contract in `chain.anchor_contracts` at startup and exits if that table is missing.

**Older contract-history installations:** 0134 preserves OLD and newly assigned contract identities
and backfills all pairs still present. It cannot reconstruct a contract address erased before the
old registry captured it. Before requesting a chain move for an affected installation, reconcile
`chain.anchor_contracts` against deployment records and the original chains' contract/event history;
register any verified missing `(chain_id, contract_address)` pairs through the worker's existing
append-only registration privilege. An absence in current rows is not evidence that an older
contract never held the batch. If that reconciliation cannot be completed, defer the move. The
reviewed checksum pin permits the exact earlier 0107 revision; it does not rerun that SQL or
certify that historical data is complete.

The worker enforces this distinction before a chain move: an existing or partially installed old
registry has no row in `chain.anchor_contract_registry_verification`, so contract discovery fails
closed and the move remains in `check_failed`. A corrected 0107 creates an `atomic_initialization`
verification only when the registry table did not exist and batches, transactions and proposals
were all empty before its atomic installation. A populated pre-0107 deployment remains unverified
even if no current row names a contract. 0134
never approves an older registry automatically. Once reconciliation has registered every verified
missing pair, the migration owner records the evidence (the worker can only read this table):

```sql
INSERT INTO chain.anchor_contract_registry_verification (id, basis, evidence_note)
VALUES (true, 'operator_reconciliation', '<record location, original chain scope and contracts checked>');
```

Replace the evidence placeholder with the reviewed inventory/reference. The row retains the
connecting database identity and timestamp, cannot be updated, deleted or truncated, and grants
no permission to alter any batch or anchor. Do not insert it merely to unblock a move. An old
unrecorded partial installation also requires reconciliation after a successful retry.

**Safe execution history (0135):** apply this migration before updating the anchor worker.
The append-only ledger records the actual outer execution transaction hashes, not Safe payload
hashes, and retains them after a resubmission clears the current transaction hash. The worker
records verified Safe-service execution evidence; application accounts cannot write the ledger.
An older executed proposal without this mapping blocks its chain move with
`send_outcome_unknown` until its actual execution is verified and recorded. Do not infer a
mapping from the latest transaction row or substitute the Safe payload hash. A finalized reverted
outer call also requires reconciliation: it does not prove the Safe's logical nonce was consumed.

For a rejected/replaced proposal, the migration operator must verify an on-chain successful
replacement or cancellation for the **same Safe, original chain and exact Safe nonce**, using
Safe-service details and receipt/log evidence. Record its actual outer transaction hash in
`chain.safe_execution_history` with the original proposal/transaction/tenant/chain identity,
`evidence_kind = 'nonce_replacement'`, and a nonempty `evidence_note` referencing that proof.
The proposal remains rejected and immutable. The worker checks this hash's receipt, confirmation
depth and configured finality before moving; absent, reverted or unfinalized evidence cannot
unblock it. An off-chain rejection alone is insufficient. Executed proposals use the default
`proposal_execution` kind. Never substitute a different Safe's or different nonce's transaction.

## Account sessions (0108) — cut-over

0108 keys sessions by subject and records the factors each one proved; identity assurance moves
from the wallet row to the subject (backfilled from the subject's highest active wallet, the
level its sessions could already reach). **Every existing session ends at this migration** —
old rows name a wallet, not what was proven — so everyone signs in again after the release.
0108 runs in one transaction; like 0107, a role that is neither superuser nor `BYPASSRLS` lifts
`FORCE ROW LEVEL SECURITY` on `core.subjects` and `core.wallet_identities` for the backfill and
waits at most 5 seconds for that lock.

What a session allows now depends on how it signed in (its authentication level). A role whose
minimum is `high_assurance` needs a passkey;
every other non-public role needs a second factor. A session without one reaches only its own
session and sign-out (`403 MFA_REQUIRED` elsewhere). Sessions also end after 30 minutes unused,
on top of the 8-hour lifetime. Disabling a wallet ends every session of its subject (AC-27).

**Wallet sign-in is removed (WP7, migration 0125).** There is no SIWE route; a wallet is only a
signing key, bound by its holder from Settings. 0125 revokes every wallet session still live,
forbids new ones, and drops `core.create_wallet_session` and `core.siwe_nonces`. The API refuses
to start with `LEGACY_WALLET_LOGIN=1` (`0` or unset is accepted, so a pipeline can drop it at its
own pace); `SIWE_DOMAIN` and `SIWE_URI` are no longer read — remove them. **Before deploying,
make sure the first operator can sign in by email** (checklist below): after 0125 a person with
no address and no linked identity cannot sign in at all.

**Passkeys and TOTP (WP3).** The API needs `WEBAUTHN_RP_ID` — the web host passkeys are bound
to, e.g. `dev-registry.globalmpc.tech` — and `WEBAUTHN_ORIGIN`, the exact origin the browser
shows, e.g. `https://dev-registry.globalmpc.tech`. Both are required in production; the origin
must be `https`, its host the RP ID or a subdomain of it, and it must equal the web origin
invitation links point at (`WEB_ORIGIN`, now required; the CDK stack sets
`WEB_ORIGIN=https://<WEB_SERVER>`), or the API refuses to start. A
passkey works only for the RP ID it was created under: **changing `WEBAUTHN_RP_ID` later makes
every enrolled passkey unusable**, and the holders need a recovery code or an admin MFA reset.
TOTP secrets are encrypted under a key derived from `SESSION_SECRET`: **rotating
`SESSION_SECRET` makes every enrolled authenticator app unreadable** (`MFA_TOTP_UNREADABLE`)
on top of ending every session; holders sign in with a passkey or a recovery code and enrol the
app again. Rotate it only with that cost planned.

`core.purge_auth_records` (run hourly by the jobs worker, `AUTH_PURGE_MS`) deletes sessions a
day after they ended.

### Deploy checklist for account sign-in (WP7) — in this order

Each step needs the one before it; skipping one leaves nobody able to sign in.

1. **Mail can be sent.** `RESEND_API_KEY` (secret) and `EMAIL_FROM` for the jobs worker, on a
   domain verified in Resend; `EMAIL_TRANSPORT=resend` (the production default). Without them no
   code or invitation reaches anyone ([Account email](#account-email-01120114--codes-invitations-email-change)).
2. **The web origin is named.** `WEB_ORIGIN` for the API (required; the CDK stack derives it from
   `WEB_SERVER`). It is the base of invitation links, the passkey origin and the OIDC redirect.
3. **Passkeys work.** `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` for the API (required in production;
   the origin equals `WEB_ORIGIN`). Choose the RP ID once: changing it later voids every passkey.
4. **Migrate**, which runs 0125: any remaining wallet session ends.
5. **The first operator exists by email.** Set `BOOTSTRAP_EMAIL` (secret) and the other
   `BOOTSTRAP_*` values in the github-manager stack; the migration task bootstraps the operator
   right after migrating ([First operator from the deploy](#first-operator-from-the-deploy)).
   For an existing legacy operator, also set `BOOTSTRAP_SUBJECT_ID` to their verified subject UUID
   to initialize the first email on that same identity; do not recreate the person. This explicit
   cutover never grants roles or raises assurance. `BOOTSTRAP_WALLET` is refused. The operator
   signs in by emailed code and enrols a passkey or authenticator app within the 24-hour window,
   then manages their signing wallet from Settings. Repeating explicit cutover with the same
   subject and email is a no-op; it does not reopen an expired window.
6. **Optional: Google / Microsoft.** `GOOGLE_CLIENT_ID`/`_SECRET`, `MICROSOFT_CLIENT_ID`/`_SECRET`
   and `MICROSOFT_ALLOWED_TENANTS`, with the redirect URI `<WEB_ORIGIN>/auth/oidc/{provider}/callback`
   registered at the provider. Never set `OIDC_TEST_RELAY_URL` outside a test run: it sends every
   provider request to a local mock; the API accepts only a loopback host for it and refuses it in production and on mainnet.
7. **Remove** `LEGACY_WALLET_LOGIN`, `SIWE_DOMAIN` and `SIWE_URI` from the environment.
8. **Check:** an invitation mail arrives, its code signs in, a second factor is enrolled, and the
   admin list shows the operator with `email` as a sign-in method.

**0125–0129 are forward-only; roll back by restore.** 0125 drops `core.siwe_nonces` and
`core.create_wallet_session` and adds a CHECK that refuses wallet sessions; 0127 adds the
suspension columns, table and outbox templates; 0128 adds `closed_reason` to the two-person request
tables, a trigger on each refusing a suspended actor, and changes the result of
`core.decide_subject_suspension` (a new `closed_requests` column, read by this release's API only);
0129 releases active break-glass elevations on a suspension or an MFA reset and adds a column
(`released_elevations`) to the result of `core.decide_mfa_reset`, again read by this release's API
only.
None has a down script, and the previous image is
not meant to run on the new schema: its wallet sign-in would find neither the table nor the
function. A failed release is rolled back as every release here is: restore the database taken
before the migration (`scripts/ops/restore.sh`) and redeploy the previous images. Sessions,
sign-ins and suspension decisions made after the upgrade are lost with that restore — record any
suspension decided in that window so it can be decided again. `pnpm check:migration-rollback`
covers exactly this path (forward on a populated copy of the previous schema, the pre-upgrade copy
unchanged, forward again); it does not, and cannot, run the old image against the new schema.

**Deploy the jobs worker with the API, or right after it and the migration.** The worker renders
the outbox mail the database writes, and 0127 adds two templates (`account_suspended_notice`,
`account_reinstated_notice`). A worker older than this release settles such a row as `failed`
(`invalid_params`, unknown template) the first time it claims it, and that mail is never resent.
Deploying the worker first is harmless (it only knows more templates); stopping the old worker
before migrating and starting the new one after is the simplest order.

## Account email (0112–0114) — codes, invitations, email change

People sign in with an 8-digit code mailed to their address (`POST /api/v1/auth/email/start`,
then `/verify`). The session it issues is `aal1`: it reaches only MFA enrollment, its own
session and sign-out until a second factor is added. New people arrive by invitation (an admin
names an address and an organisation; the invitation carries no role and lasts 72 hours), and
an address is changed only by two admins other than the person, followed by a code sent to the
new address — completing it ends every session of that person.

**0113 ends every `email_code` session issued before it**: they were minted without a consumed
code, which 0113 makes impossible. Nobody signed in that way outside tests before WP2.

**Web session (WP6).** The web server keeps the browser's session in an HttpOnly cookie and turns
it into the API's bearer (`apps/web/src/proxy.ts`); the API is unchanged and reads no cookie.

| Setting | Where | Notes |
| --- | --- | --- |
| `WEB_ORIGIN` | web (run time) | The public origin of the web app, e.g. `https://<WEB_SERVER>`. The proxy compares a mutation's `Origin` with it (the cross-site check); behind a load balancer the request's own `Host` is the internal one, so **set it on every deployment**. Unset, the request's protocol and `Host` are used. Same value as the API's `WEB_ORIGIN`. |
| `NODE_ENV=production` | web | Makes the cookie `__Host-mpc_session`, `Secure`, even when TLS ends at the load balancer. Outside production over plain http the cookie is `mpc_session` without `Secure` (local development only). |
| `API_ORIGIN` | web (run time) | Unchanged: where `/api/*` is proxied. |

The cookies are `SameSite=Strict` and host-only; the OIDC flow keeps its browser binding in a
second HttpOnly cookie for 10 minutes. `GET /api/v1/auth/methods` tells the sign-in screen which
methods to offer. After a deployment: sign in, then confirm in the browser's developer tools that
`__Host-mpc_session` is HttpOnly and Secure and that no `mpc.session.token` remains in local
storage; a `POST /api/v1/auth/logout` with `Origin: https://example.com` answers 403
`CROSS_SITE_REQUEST_REFUSED`.

**Large uploads.** The streaming upload (`POST /api/v1/projects/:id/uploads/stream`) is not
handled by the proxy: Next.js keeps only the first `proxyClientMaxBodySize` (10 MiB) of a body a
proxy handles, so a larger file reached the API cut off. A route handler
(`apps/web/src/lib/stream-upload.ts`) pipes that body to `API_ORIGIN` as it arrives, with the
proxy's cookie, cross-site and edge-header rules, and refuses a declared length over the API's
2000 MiB cap. The web task therefore holds an upload's connection open for its whole duration; the
ALB idle timeout and any CDN in front bound how long an upload may take (see the CDN row below).
After a deployment, upload a file over 10 MiB in the Data Room and confirm it lists at its full size.

**Two rules the proxy relies on.**

- *The API never sets a cookie.* The general `/api` path is a rewrite, and the API's
  `set-cookie` would pass through it to the browser on the web origin — beside, or over, the
  session cookie only the proxy may write. Session state reaches the browser only through the
  routes the proxy answers itself.
- *Encoded paths are refused.* The proxy decides by the literal path which answers become
  cookies, so it answers 400 `PATH_ENCODING_REFUSED` to percent-encoding in any path that decodes
  into `/api/v1/auth`, to an escape that does not decode, and to a `.`/`..` segment; the API
  refuses the same encoded auth paths in an `onRequest` hook. Encoding elsewhere (a public
  registry key is free text) is forwarded as before.

**Mail.** The API never sends mail; it queues it in `core.email_outbox` in the transaction that
issued the code, and the jobs worker sends it.

| Setting | Where | Notes |
| --- | --- | --- |
| `EMAIL_TRANSPORT` | API and jobs worker | `resend` / `smtp` / `log`. Production accepts only `resend` (the default there) and refuses to start otherwise. |
| `RESEND_API_KEY` | jobs worker only (secret) | Required with `resend`. `file:`/`env:` references work. |
| `EMAIL_FROM` | jobs worker only | `MPC Registry <no-reply@…>` on the domain verified in Resend. Required with `resend`. |
| `WEB_ORIGIN` | API | Required. Origin invitation links open (`<origin>/invitations/accept#token=…`), the passkey origin and the OIDC redirect base. CDK sets `https://$WEB_SERVER`. |
| `EMAIL_SEND_TIMEOUT_MS`, `EMAIL_MAX_ATTEMPTS`, `EMAIL_BACKOFF_MS` | jobs worker | 10 s, 5, 5 s (doubling). A temporary failure is retried up to the cap; anything else fails at once. |

The deployed key and sender live in `globalmpc-github-manager` (`secrets.<env>.RESEND_API_KEY`,
`vars.<env>.EMAIL_FROM`). The worker stack refuses to synthesize without them, so the deploy
workflow must pass `RESEND_API_KEY` as a secret, as `.github/workflows/cdk-diff.yaml` does.

The worker logs `email.sent` / `email.retry_scheduled` / `email.failed` with the outbox id, the
template, a masked address (`p***@example.com`) and a reason code (`resend_http_403`, `timeout`,
…) — never the code, the link or a provider response. `resend_http_403` usually means the
`EMAIL_FROM` domain is not verified. A row's address and code are cleared as soon as it is sent,
fails or expires; settled rows, challenges and rate-limit events are deleted a day later by the
hourly purge (`core.purge_email_auth_records`).

**Limits** (in the database, per 15 minutes): 5 code requests per address (or per invitation)
and 20 per requester IP; 10 code checks per address (or invitation) and 50 per IP; 5 wrong
tries per code. An IPv6 requester counts as its /64. Asking for a code answers the same, after
the same minimum time, whether or not the address has an account.

**Locally**, `docker compose up` starts Mailpit and the jobs worker sends to it
(`EMAIL_TRANSPORT=smtp`); read the codes at http://localhost:8025. Tests use `log`, which writes
the rendered message to `core.email_test_sink` instead of sending anything.

**First operator by email.** `pnpm --filter @mpc/api bootstrap` requires `BOOTSTRAP_EMAIL` and,
since WP7, refuses `BOOTSTRAP_WALLET`: the person signs in by code and binds their signing wallet
from Settings. An address already
on another person, or a different address already on the selected person, stops the run
(changing an address is the two-person email change). The run prints whether it bound an
address, never the address itself.

**First-enrolment deadline (24 hours).** A person signing in by emailed code has only `aal1`
and must enrol a passkey or an authenticator app **within 24 hours of being created** — after
that, enrolling a first factor needs an approved admin MFA reset. The first operator has no
second admin to approve one, so **re-running ordinary email-based `bootstrap`** with the same
input recovers: for an existing person who holds **no** passkey or TOTP it opens a fresh 24-hour
window (output
`enrolmentWindowOpened: true`, `enrolmentWindowUntil`), audited as `deploy_bound`
(`bootstrap.mfa_enrolment_window.opened`). While a window is open a re-run records nothing new.
Once the person holds a factor, a re-run opens nothing (`enrolmentWindowUntil: null`) and never
touches existing factors, codes or sessions — from then on only the two-person admin reset
reopens a window. The explicit `BOOTSTRAP_SUBJECT_ID` legacy cutover below opens a window only
when it first initializes the address; its same-subject/email rerun never reopens one.

### First operator from the deploy

The migration task (`docker/migrate-task.sh`) runs **migrate → bootstrap → `service-token
ensure`**, each only if the one before it succeeded. Bootstrap runs only when `BOOTSTRAP_EMAIL`
is set; unset, the task logs `migrate_task.bootstrap.skipped` and goes on — the normal state of
an environment that already has its operators. No step after the deploy is needed.

Set the inputs in `mustcompany/mustcompany-github-manager` under
`projects/mpc/globalmpc-registry-private` (Pulumi stack `globalmpc-registry-private`) for the
environment, then apply the stack and deploy. Its deploy workflow forwards repository variables
into the synth environment, including `BOOTSTRAP_SUBJECT_ID`; configuring the value is an
operator action, and this code change does not set it in a deployed environment:

```sh
# Personal data: a secret. With no value on the command line Pulumi prompts for it, so the address
# stays out of shell history.
pulumi config set --secret --path -s globalmpc-registry-private 'secrets.develop.BOOTSTRAP_EMAIL'
pulumi config set --path -s globalmpc-registry-private 'vars.develop.BOOTSTRAP_TENANT_SLUG' registry
pulumi config set --path -s globalmpc-registry-private 'vars.develop.BOOTSTRAP_TENANT_NAME' 'MPC Registry'
pulumi config set --path -s globalmpc-registry-private 'vars.develop.BOOTSTRAP_ORG_NAME' '<organization legal name>'
pulumi config set --path -s globalmpc-registry-private 'vars.develop.BOOTSTRAP_SUBJECT_NAME' 'First operator'
# Optional, with the CLI's defaults: BOOTSTRAP_JURISDICTION (MNG), BOOTSTRAP_ROLE (mpc_operator),
# BOOTSTRAP_ASSURANCE (high_assurance).
# Existing legacy operator only: verify the tenant and stable subject UUID before authorizing.
pulumi config set --path -s globalmpc-registry-private 'vars.develop.BOOTSTRAP_SUBJECT_ID' '<existing-subject-uuid>'
```

- **Where they go.** Only the migration task gets them, and only while `BOOTSTRAP_EMAIL` is set:
  the address by Secrets Manager reference (its own secret, readable by the task's execution role
  only), the rest as plain values in the task definition — so `BOOTSTRAP_SUBJECT_NAME` is visible
  to anyone who can describe it; a label such as "First operator" is enough, the person can be
  renamed later. No service task sees any of them. Like every secret here, the address is also
  in the synthesized template ([below](#service-tokens)). Synth refuses `BOOTSTRAP_EMAIL` without
  the tenant slug and name, organization and subject name. `BOOTSTRAP_EMAIL` is optional, so it
  is not in `cdk_diff.secrets`.
- **Logs.** The task never prints the address: it moves it into an unexported shell variable
  before migrating, hands it to the bootstrap step in its environment only, and the step prints
  ids and `emailBound`, never the address.
- **Every deploy re-runs it.** Ordinary email bootstrap reuses the tenant, organization, person
  and role binding. While the person holds no passkey or TOTP, it may reopen the 24-hour
  first-enrolment window (audited as `deploy_bound`); once they hold one, it opens nothing.
  Explicit legacy cutover (`BOOTSTRAP_SUBJECT_ID`) instead requires the existing identity and
  authority below; the same subject/email rerun changes nothing, including the enrolment window.
- **It never undoes a two-person decision.** It stops, writing nothing, when the person is
  **suspended** (no role, no enrolment window — reinstatement is two-person), or when their
  binding of `BOOTSTRAP_ROLE` was **revoked** (a two-person revocation or a break-glass access
  quarantine) and none is live: re-granting it on every deploy would reverse that decision. It
  stops rather than skips, because the environment would otherwise go on naming as its operator
  someone who no longer is one. Either way the fix is configuration: remove `BOOTSTRAP_EMAIL`
  (the usual end state once the operator has signed in and enrolled), or have an admin reinstate
  the person or grant the role again through the API.
- **It creates only the first holder of the role.** A person is found by address, so a deploy
  still naming the operator's address after the two-person email change moved it would otherwise
  create a new person on the old address — with the role and an open enrolment window, for
  whoever reads that mailbox. Bootstrap creates a new person only when nobody in the tenant has
  ever held `BOOTSTRAP_ROLE` (revoked bindings count), and never on an address a completed email
  change in the tenant moved away from. Either stops the run and writes nothing. The fix is
  configuration: remove `BOOTSTRAP_EMAIL`, or set it to the operator's current address (a no-op
  on an unchanged operator). Later holders of the role are invited by an admin. A moved address is
  refused whatever `BOOTSTRAP_ROLE` names, even a role the tenant never had — but only while the
  previous address is kept: the auth purge forgets it 90 days after the change, and from then on
  only the role-history check remains (an address moved off the only holder of a role still
  refuses for that role; for a role nobody ever held, the old address would be a first holder).
- **Failures stop the deploy.** A refusal above, an address already on a person in another
  tenant, an unknown role, assurance below the role's minimum or missing input makes the task
  exit non-zero, and the pipeline does not deploy the service stacks — as with a failed
  migration or `ensure`. Migrations that applied stay applied; fix the input and deploy again.
- **The scan worker's tenant.** `SCAN_SERVICE_TENANT_SLUG` is not defaulted to
  `BOOTSTRAP_TENANT_SLUG`: the scan worker reads it too, so it is set explicitly once and both
  read the same value. Set both to the same slug on a new environment and one deploy creates the
  tenant, then registers the token for it.
- **The connecting role.** The task connects as the migration table owner. Bootstrap and
  deploy-time token registration are tested under `NOSUPERUSER NOBYPASSRLS` with FORCE RLS.
  This is a local PostgreSQL test, not proof of the deployed Aurora role configuration.
  Existing cross-tenant authentication functions and worker roles have separate requirements
  described above; successful bootstrap alone does not establish runtime readiness.

**Running it by hand** stays available — locally, under Compose, or when the deploy cannot:
`pnpm --filter @mpc/api bootstrap` over the migration connection, with the same variables in the
environment. It behaves exactly as the deploy step.

**Explicit legacy operator cutover is an operator-trusted migration action.** For a pre-account
person, set `BOOTSTRAP_SUBJECT_ID` to the exact UUID from the tenant's historical subject record,
along with `BOOTSTRAP_EMAIL` and the other inputs above. Verify the person and their mailbox
outside this CLI before authorizing the run. The address or a wallet address never selects the
historical identity implicitly; a disabled wallet does not change the UUID to select.

This mode initializes only a **NULL email** on a non-suspended person with historical
operator-bound wallet data and no account-session, provider, MFA, recovery or email-change
history (revoked records count too). They must already hold the configured active role in the
configured organization, at an adequate **stored** assurance level. It never creates a subject,
grants a role, upgrades assurance, restores a wallet or revives a legacy session. Addresses
claimed by another account or retained as moved by a completed email change are refused.
An existing different address requires the two-person email-change flow. A same-subject/email
rerun is a no-op; it does not provide account recovery or reopen an expired enrolment window.

The initial email assignment and any needed 24-hour enrolment window commit together. A person
still within the creation-time window uses that existing deadline. The stable subject,
role bindings and historical reviews/approvals remain intact; legacy sessions revoked by 0125
stay revoked. No mail is sent by this CLI. The audit records `deploy_bound`,
`bootstrap.legacy_email.initialized`, plus `bootstrap.mfa_enrolment_window.opened` when a reset
window is actually opened; output contains
the subject UUID and `emailBound`, never the email address. Review those records after cutover,
then remove `BOOTSTRAP_SUBJECT_ID` and `BOOTSTRAP_EMAIL` from deploy configuration. Established
accounts use the normal two-person email-change and MFA-reset flows. Restrict the migration
connection and deployment permission to operators authorized to perform this identity mapping.

### Rotating a reviewer's or approver's signing wallet (shared dev deployment)

On the shared dev deployment **every existing reviewer and approver wallet is operator-bound**
(`bound_via = 'operator'`: seeded, or bound by `bootstrap`/an admin before WP5). Replacing such a
wallet from Settings is allowed and keeps the person's sessions, but it is a disable of the
operator-verified wallet, so the person's identity assurance falls to `wallet_only` (0130). Every
role whose minimum is above that stops taking effect at once — the `reviewer_*` roles,
`gate_approver`, `disclosure_approver`, `issuer_officer`, `mpc_operator`, `security_operator` and
the other `high_assurance` roles; `identity_bound` roles such as `data_steward` too. The roles are
not revoked, and nothing has to be granted again. The person sees this right after the replace,
in the header (the roles marked inactive, "identity verification needed — ask an admin") and on
the verification and gate screens, which say so before anything is signed.

**After every such rotation an administrator restores the level** — someone holding
`admin.subject.manage` (`mpc_operator` or `security_operator`), and never the person themselves
(the server refuses setting one's own level):

1. Confirm out of band that the new wallet is the person's: they sign in, open Account settings
   and read the new signing wallet's address to you over a channel you already trust; compare it
   with **Admin → People → wallets** for that person.
2. **Admin → People →** the person's row **→ Set assurance**. Choose the level they had before
   (`high_assurance` for reviewers and approvers; `identity_bound` if that was all they held) and
   write what you checked in **What you checked (required)** — it goes to the audit record.
3. Ask the person to reload: their roles take effect from the next request. No sign-out is needed.

The same holds for a key that is lost or compromised: bind the replacement first (the old key is
disabled in the same step), then restore the level as above. Binding by proof never raises the
level, so a newly invited reviewer or approver needs the same **Set assurance** step once their
first wallet is bound.

## Service tokens

The scan worker and the CRE workflow authenticate with **service tokens**, not wallets
(decision D7). A token belongs to one `service` subject, carries scopes (`scan_result`,
`cre_report`), and reaches only the routes those scopes name; only service roles
(`scan_service`, `cre_reporter`) are effective through it, and no person session makes those
roles effective. Only the token's hash is stored; a token lives at most a year. Every change is
audited as `deploy_bound`. `ensure` runs tenant-scoped over the migration table-owner connection.
The other database commands retain their existing superuser/BYPASSRLS contract; `generate`
requires no database connection:

```sh
pnpm --filter @mpc/api service-token generate                 # a new token on stdout; no database
SERVICE_TOKEN=… pnpm --filter @mpc/api service-token ensure <tenantSlug> <label> <role> <scope,...> [ttlDays=365] [overlapHours=24]
pnpm --filter @mpc/api service-token create-subject <tenantSlug> <displayName> <role>
pnpm --filter @mpc/api service-token issue <tenantSlug> <subjectId> <label> <scope,...> [ttlDays=90]
pnpm --filter @mpc/api service-token rotate <tokenId> [overlapHours=24] [ttlDays=90]
pnpm --filter @mpc/api service-token revoke <tokenId>
pnpm --filter @mpc/api service-token list <tenantSlug>
```

### Scan worker: generated ahead, registered by the deploy

The scan worker's token is a secret like `SESSION_SECRET`: generated once, kept with the
environment's secrets in `globalmpc/globalmpc-github-manager` (Pulumi stack
`globalmpc-registry-private`, KMS-encrypted), and flowing GitHub environment secret → CDK →
Secrets Manager → task environment. Nobody copies a value after a deploy:

1. **Generate** a value and store it, encrypted, without it touching the terminal or shell history:

   ```sh
   pnpm --silent --filter @mpc/api service-token generate \
     | pulumi config set --secret --path -s globalmpc-registry-private 'secrets.develop.SCAN_SERVICE_TOKEN'
   ```

   (`pulumi config set --secret --path -s globalmpc-registry-private 'secrets.develop.SCAN_SERVICE_TOKEN' <value>`
   is the same with the value as an argument.) Set `SCAN_SERVICE_TENANT_SLUG` — the tenant the
   scan worker reports for, a plain variable — for the environment in the same stack, next to
   the other plain variables. Apply the stack so GitHub has both. **One tenant per
   deployment:** the token belongs to that tenant and the API refuses its report on any other
   tenant's upload, so the scan worker leases only that tenant's uploads (it reads the tenant's
   id by slug at start and exits if there is none). Another tenant's uploads stay quarantined,
   untouched, until a deployment scans for it.
2. **Deploy.** CDK refuses a value that is not a generated token (wrong prefix, length or
   alphabet), naming the variable and never the value. The migration task migrates and then,
   only if every migration applied, runs `service-token ensure <SCAN_SERVICE_TENANT_SLUG>
   scan-worker scan_service scan_result`: it creates the `scan-worker` service subject on first
   use and registers the token's hash. The token reaches that step in its environment only — not
   the migration's, not a command line, never a log line. Only the migration task's execution
   role can read its Secrets Manager secret; nothing in the app can write one.
3. **The scan worker** reads the same value. A worker that starts before the migration task has
   run gets `401` (`scan.report_unauthorized`) and leaves uploads unscanned (fails closed). A
   `401` does not use up the upload's scan attempts, so the file is scanned again later and
   reported once the token is registered — no restart needed. After a `401` the worker stops
   leasing and backs off — 5 seconds, doubling to 5 minutes, jittered — logging
   `scan.unauthorized` (level `error`, with `failures` and `backoffMs`) and keeping
   its heartbeat with `status: "unauthorized"`, so the data room shows "The scan worker cannot
   report results" (scanner state `unauthorized`) rather than a healthy worker. The `scan.stuck`
   check keeps running. The first accepted report clears the status and the normal poll resumes.
   The API exports this as `mpc_worker_unauthorized{state="scan"}` (1 while refused), and
   `MpcScanWorkerUnauthorized` (`config/observability/alerts.yml`) pages after 10 minutes —
   the liveness rules stay quiet for a worker that is alive, and a quiet tenant never reaches
   `MpcUploadsStuckInQuarantine`. When it fires: `service-token list <tenantSlug>` to see whether
   the token was revoked, expired or replaced, then store a current value and redeploy.
   The deploy pipeline runs the migration task before the service stacks, as for every release,
   which keeps that window to a rotation's or a revocation's.

Running `ensure` again with the same value changes nothing (the expiry is not extended). The
tenant must exist. The migration task bootstraps before `ensure`, so on a brand-new environment
with `BOOTSTRAP_TENANT_SLUG` equal to `SCAN_SERVICE_TENANT_SLUG` one deploy creates the tenant and
registers the token ([First operator from the deploy](#first-operator-from-the-deploy)); without a
bootstrap the task fails at `ensure` until the tenant exists — migrations have applied, deploy
again after bootstrapping.

**Rotation** is a new value: generate and store it as in step 1, then deploy. `ensure` registers
the new hash and brings every other live token of the service to end after the overlap
(24 hours), so the old worker task keeps reporting while the new one starts. Rotate yearly:
from 30 days before expiry `ensure` prints a warning on every deploy. Going back to a value a
rotation replaced (a rolled-back or stale secret) fails the migration task — `ensure` says the
token "was replaced by a later token of this service" — instead of deploying a worker whose token
ends with the overlap; store the current value, or generate a new one.

**Revocation** (a leaked value): `service-token list <tenantSlug>` for the id, `service-token
revoke <tokenId>` — the token gets `401` at once — then rotate as above. A deploy never
re-registers a revoked or expired value: `ensure` refuses it and the migration task fails, so
the stored value has to change. Revocation leaves no overlap; uploads wait unscanned until the
new value is deployed.

**Incident handling:** revoke first, then rotate; check `audit.events` for `service_token.*`
rows and the token's `last_used_at` (`service-token list`) to bound the exposure. A scan result
reported with a leaked token is attributable to the `scan-worker` subject in the audit trail;
rescan affected uploads if needed.

**Where else the value can be read.** Secrets Manager is not the only copy:

- **The CloudFormation template.** CDK builds the secrets at synth from the GitHub-provided plain
  values (the scan token's with `SecretValue.unsafePlainText`; the rest of `SECRETS` —
  `SESSION_SECRET`, both database URLs, `ANCHOR_SIGNER_PRIVATE_KEY` — from the same plain
  strings), so they are written in plain text into the synthesized template. Anyone allowed
  `cloudformation:GetTemplate` on the stacks, or able to read the CDK asset (bootstrap) bucket,
  can read them all. Treat both permissions as secret-read access: keep them to the deploy role
  and break-glass operators, and include them when bounding a leak. Moving the values out of the
  template (create the secrets outside CDK and reference them by name) is a follow-up, not part
  of this change.
- **The migration task's process environment.** ECS injects `SCAN_SERVICE_TOKEN` into the
  container's environment at start. The task script copies it into an unexported shell variable
  and unsets it before running anything, so neither the migration nor the CLI inherits it, but
  the container's first process keeps its initial environment: `/proc/1/environ` inside that
  container holds the value while the task runs. Only something already running in the task can
  read that.

Locally, Compose's `scan-token` service does the same: generates a value into the `scantoken`
volume once, registers it for `SCAN_SERVICE_TENANT_SLUG` (unset: generated, not registered, and
the scan worker exits at start — bootstrap a tenant, set it, run `docker compose run --rm
scan-token` and start the worker again), and the scan worker reads `file:/run/scan-token/token`
and scans that tenant's uploads. Deleting the volume rotates.
The E2E seed runs `ensure` with a value derived from the run's throwaway demo keys.

### CRE workflow: issued with the CLI

The CRE workflow's `REGISTRY_BEARER_TOKEN` lives in the Chainlink DON's secret store, outside
AWS and outside the GitHub → CDK flow, so no deploy step here can see or register it. It stays
on the operator path:

```sh
pnpm --filter @mpc/api service-token create-subject <tenantSlug> "CRE workflow" cre_reporter
pnpm --filter @mpc/api service-token issue <tenantSlug> <subjectId> cre-workflow cre_report
```

`issue` and `rotate` print the token once, as the `token` field of one JSON line on stdout; put it
straight into the DON secret. It cannot be shown again. `rotate` keeps the old one working for the
overlap (at most 7 days, never extended) so the new one can be rolled out first. The same
generate-and-`ensure` pattern applies once a deploy can reach that secret store.

**Cleanup after this release:** the scan worker no longer signs in with a wallet. Remove the
`SCAN_SERVICE_PRIVATE_KEY` secret from each environment and disable the scan service's old
wallet binding.

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

- **First operator.** `secrets.develop.BOOTSTRAP_EMAIL` and the `vars.develop.BOOTSTRAP_*` values;
  the deploy's migration task bootstraps ([First operator from the deploy](#first-operator-from-the-deploy)).
  Existing legacy operators use their explicit `BOOTSTRAP_SUBJECT_ID` to retain their identity;
  this does not recreate them or restore revoked wallet sessions. The operator binds a signing
  wallet on 5611 from Settings after signing in (the binding uses the
  API's `CHAIN_ID`). Remove `BOOTSTRAP_EMAIL` once they have enrolled a second factor.
- **Scan service identity.** Generate `SCAN_SERVICE_TOKEN` and set `SCAN_SERVICE_TENANT_SLUG` in
  the github-manager stack ([Service tokens](#service-tokens)); the deploy registers it. Without
  them the worker and migration stacks do not deploy and uploads stay quarantined.
- **Sign-in.** By account only (email code, then a second factor). Remove `LEGACY_WALLET_LOGIN=1`
  before deploying WP7, or the API does not start; follow the [deploy checklist](#deploy-checklist-for-account-sign-in-wp7--in-this-order).
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
The web proxy forwards the visitor's `x-forwarded-for` as it received it — that is what the API
reads the visitor address from in this layout, so the proxy cannot drop it. A visitor can put any
address on the left of that header. **Without `EDGE_PROXY_SECRET`, set `TRUSTED_PROXY_HOPS` to
exactly the number of entries the real chain appends** (one per proxy that appends, e.g. the load
balancer in front of `web`); one more than that and the API reads the visitor's own forged entry,
so every forged address gets its own rate-limit and sign-in bucket.
When the web app runs on a CDN (Vercel or similar), three things stop holding, and each has a
setting.

| Problem | Setting | Where |
|---|---|---|
| The CDN's egress addresses are not fixed, so no range can name the peer; every visitor becomes the CDN and the sign-in cap (`AUTH_RATE_LIMIT_MAX`) is shared by the whole site | `EDGE_PROXY_SECRET` — the same value on both sides. The web proxy attaches it with the visitor address it saw; the API uses that address only when the secret matches. Minimum 32 characters; generate it, never reuse another secret. Set it only behind a platform that overwrites `x-real-ip` and `x-forwarded-for` with the address it saw (Vercel does); in front of anything that passes a visitor's own `x-real-ip` through, the visitor picks its address and every forged one gets its own cap | web **and** API |
| The CDN cuts a proxied request at its own time cap (Vercel: 120 s), which a large evidence upload does not fit in | **Not available since WP6.** `NEXT_PUBLIC_API_DIRECT_ORIGIN` (web, build time) used to send the streaming upload straight to the API host with the page's token. The token is now an HttpOnly cookie on the web host that page script cannot read and that is not sent to another host, so every upload goes through the web origin, streamed past the proxy without buffering (see "Large uploads" above), and the platform's time cap applies. The setting is read but ignored. The CDK deployment never set it (cdk/README.md), so it is unaffected; a deployment behind a CDN with a short cap needs a scoped, short-lived upload credential before the direct path can return. `EDGE_WEB_ORIGIN` (API) is unchanged and admits nothing the web sends today | web (build) · API |
| `/health/*` and `/metrics` carry no auth; an API host reachable from the internet would expose readiness and the operational gauges | `OPS_ENDPOINT_CIDRS` — socket peers allowed on those paths, default the private ranges. Anyone else gets the 404 of an unknown path. List the collector's and the orchestrator's ranges | API |

Values that change with the public address, as before: `WEB_ORIGIN` (API),
`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` (API; see the passkey note above before changing the RP
ID), `API_ORIGIN` and `WEB_ORIGIN` (web, run time).

What to confirm after the first deployment: sign in twice from two networks and check the
API log does not report the requester as unroutable; upload a file above the base64 cap and
confirm it completes through the proxy within the platform's cap; request `/health/ready`
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
| `scan-worker` | `apps/scan-worker` | Worker DB, quarantine storage, scanner connection and scan service token |

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

### Tenant-scoped bootstrap authority (0136)

| Case | Authority and scope | Outcome |
| --- | --- | --- |
| Initial operator / unchanged rerun | Migration table owner; selected tenant, live account state | Create first holder or preserve existing authority |
| Same email in another tenant | Global unique email constraint; tenant-scoped lookup | Refuse and roll back the newly-created tenant |
| Legacy subject ID | Exact subject in configured tenant; existing role and assurance | First email only; no role or assurance escalation |
| Token registration / rerun | Migration table owner; selected tenant and service | Preserve revocation/expiry semantics; global token uniqueness rejects other tenants |
| Enrolment window | Migration-only EXECUTE ACL, invoker privileges and scoped subject | Missing/wrong-tenant subject refuses before changing context |
| Application/worker connection | No migration table ownership | Refused before bootstrap or ensure writes |

0136 changes only the bootstrap enrolment function to invoker security with RLS on. Its
migration-owner-only ACL is preserved. It does not disable RLS, change table ownership, grant
new runtime privileges, or alter the other cross-tenant SECURITY DEFINER functions.
