# Backup and restore

There are two scripts: `scripts/ops/backup.sh` and `scripts/ops/restore.sh`. This document
records what the two capture and do not capture, and how to confirm that a restore succeeded.

## The database and the object store are one unit

Backed up separately, they cannot be restored.

- With only the DB, the `core.artifacts` rows exist but the objects do not — the evidence cannot be opened.
- With only the objects, there is no way to know what they are evidence of, or who received them, when, and under which hash.

So `backup.sh` puts both in the same directory and binds them with a single `manifest.json`.
A backup taken without `OBJECT_BUCKET` gets `complete: false` in the manifest, and `restore.sh`
refuses that backup unless `ALLOW_DB_ONLY=1` is set.

## Backup

```bash
DATABASE_URL=postgres://... \
BACKUP_DIR=/backups/$(date -u +%Y-%m-%dT%H-%M-%SZ) \
OBJECT_BUCKET=mpc-evidence \
OBJECT_ENDPOINT=https://... \
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  ./scripts/ops/backup.sh
```

**What it refuses**

- `BACKUP_DIR` already exists — overwriting it makes the point in time unknowable
- The `pg_dump` major version is lower than the server's — `pg_dump` cannot dump a server newer
  than itself. The worst state is operating under the belief that a backup was taken

**What the manifest records**

`takenAt` (UTC) · `serverVersionNum` · `dumpSha256` · `schemaMigrations` ·
`latestMigration` · `auditEvents` · object count and bytes · `objectDigest` · `complete`.

The figures are recorded so that there is something to compare against after a restore.
"The restore finished" and "the restore is correct" are different statements.

### Statistics are read from the **same snapshot** as the dump

Found in an inspection on 2026-09-10: previously, `audit.events` was counted over a separate
connection after `pg_dump`. If even one business event arrived in between, the row count in the
dump and the row count in the manifest diverged, and **a healthy dump failed restore verification.**
There is no window in production during which writes stop, so this mismatch was the default state.

Now a transaction is opened, its snapshot is exported, `pg_dump` runs against that snapshot, and
the statistics are read inside the same transaction. Backup and restore under concurrent writes are
exercised for real by `scripts/ops/test-backup-restore.sh`.

### Per-object hashes

`objects.sha256` is stored alongside, and the hash of that file is the manifest's `objectDigest`.
Count and bytes alone do not catch **changed content** — a backup in which evidence was quietly
replaced by a different file still looks healthy after a restore.

## Restore **only into an empty database**

```bash
createdb -h HOST -U postgres mpc_restored

BACKUP_DIR=/backups/... \
TARGET_DATABASE_URL=postgres://.../mpc_restored \
OBJECT_BUCKET=mpc-evidence OBJECT_ENDPOINT=https://... \
  ./scripts/ops/restore.sh
```

If any of the `core`, `chain`, or `audit` schemas exists, the restore is refused.

**Why not pour into a live DB:** `audit.events` and `chain.reorg_events` are append-only and the
application paths have no UPDATE or DELETE (migrations 0003 and 0012). Pouring a dump into a live
DB appends past records, so "what existed when" is written twice. For things that cannot be undone,
order matters — **pour into a new DB, verify, then move the connection.**

**Verification** — `restore.sh` compares against the manifest. A single mismatch ends in failure.

| Comparison | Why |
|---|---|
| sha256 of `db.dump` | Restoring from a corrupted dump makes a partial restore look like success |
| `schema_migrations` count and latest name | If the schema version differs, the app breaks the moment it connects |
| `audit.events` count | Whether the append-only record is intact |
| Hash of `objects.sha256` | Whether the list itself was changed. Checking files against a trusted list lets a corruption that edited the list pass |
| sha256 of each object file | Count and bytes do not catch **changed content** |
| Object count in the restored bucket | Whether the sync uploaded only part |
| Sample download of restored objects | A successful sync and **evidence that can be opened** are different things. With mismatched permissions or policies, the listing shows but the body cannot be read |

**A complete backup (`complete: true`) requires three things before the restore starts** —
the `objects/` directory, `objects.sha256`, and `OBJECT_BUCKET`. Before a fix on 2026-09-10,
the object-copy branch was **silently skipped** when the three were absent and "restore complete"
was printed. A service with a live DB and no evidence files was classified as a successful restore.

The sample size is `RESTORE_VERIFY_SAMPLE` (default 20), and **the number of objects checked is
printed in the output.** The point is not to hide the range that was verified.

## What is **not** in the backup

| Missing | How to recover it |
|---|---|
| Cluster roles (`mpc_app_login`, `mpc_worker_login`) | `pg_dump` captures only what is inside the database. After the restore, run `pnpm --filter @mpc/db login-roles` or the deployment's IAM / secret-manager procedure. `restore.sh` reports when they are missing |
| Secrets (`SESSION_SECRET`, signing keys, object store credentials) | Never placed in the backup. The secret manager holds them |
| BNB Chain state | The chain is not something we back up. The records in `chain.transactions` are in the dump; the actual transactions are on the chain |
| Deployment images and configuration | Deployment rollback is a separate procedure |

## Restore drill

The `backup/restore smoke` item in the R0 exit criteria means **a record of actually running**
this procedure. Having the scripts is not the same as having done the drill.

### Run it with `drill.sh`

Done by hand, each run differs slightly, and a drill run differently cannot be compared with the
next one. `scripts/ops/drill.sh` runs steps 1–3 below in one go and prints the result as a table
that can be pasted into the operations log.

```bash
DATABASE_URL=postgres://.../mpc \
ADMIN_DATABASE_URL=postgres://.../postgres \
OBJECT_BUCKET=mpc-evidence OBJECT_ENDPOINT=https://... \
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  ./scripts/ops/drill.sh
```

**It deletes nothing.** The restore target DB and bucket are created fresh under timestamped
names and removed when done (`DRILL_KEEP=1` keeps them). If they already exist, it refuses —
pouring onto something live is not a drill but an incident.

Why `ADMIN_DATABASE_URL` is needed separately: `CREATE DATABASE` can only run while connected
to a different database.

**What the script checks:**

1. Backup → restore runs to the end
2. The migration count and `audit.events` count of the restored copy match **the live original
   right now** (`restore.sh` compares against the manifest — that is a comparison with the moment
   of backup. Here, whether the backup is stale is checked as well)
3. **A second restore into the live DB is refused** — half of a drill is not doing what must not be done

### What the script does not check — do by hand

4. Create the login roles and start the API against the restored DB
5. Confirm that one unauthenticated Explorer query and one login work

**Why this is not automated:** both require starting the application, and putting that into the
drill script turns it into a deployment tool. Whether the restore produced **readable data** is
something a person should confirm once.

6. Record the table printed by `drill.sh` and the elapsed time in the operations log

**Not yet decided:** backup frequency, retention period, and storage location depend on OD-17
(data jurisdiction) and OD-32 (RPO/RTO). Both are unresolved, so this document sets no values —
developers do not fix them on their own (D-41).

## Local check (2026-08-26)

Run against a temporary Postgres 17 container.

- Backup — 25 migrations · 164 rows in `audit.events` · dump sha256 recorded
- Restore — all three comparisons matched
- Three refusal paths confirmed: non-empty target DB · dump with a mismatched hash · pre-existing `BACKUP_DIR`

**This was not a drill.** It was not the production configuration and did not include the object
store (`complete: false`). The drill remains an open item.
