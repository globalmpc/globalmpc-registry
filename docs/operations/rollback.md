# Rolling back a release

A rollback redeploys the previous release's images — API, worker and web — onto the database the
newer release has already migrated. There are no down migrations, and there will not be: a
migration that removes what a newer release wrote cannot be checked the way a forward migration
is. So a rollback is safe only when **the previous release's code still works on the newer
schema**, and that is something to find out before the newer release ships, not during an
incident.

## Before a release ships: run the drill

```sh
ADMIN_DATABASE_URL=postgres://postgres:...@127.0.0.1:5432/postgres \
FROM_REF=<release now running> TO_REF=<release about to ship> \
./scripts/ops/rollback-drill.sh
```

`ADMIN_DATABASE_URL` points at a throwaway cluster — the drill creates a database and the test
suites create login roles. It never needs a deployment platform.

| Step | What it shows |
|---|---|
| `TO_REF` migrates a fresh database | The schema the rollback will land on |
| `FROM_REF` runs its own migrate step | Whether the previous image starts at all. The runner skips migrations it does not know and rejects an applied migration whose checksum changed — if that happens, the previous image stops before the API starts |
| `FROM_REF`'s API and worker suites run on that database | Which code paths of the previous release break on the newer schema |

**If the drill fails, the release is not rollback-safe as written.** Two ways forward:

1. Make the migration compatible with the previous code (add before you require: new columns
   nullable or defaulted, new constraints and triggers only after the code that satisfies them
   has shipped once). Preferred — the rollback stays an image swap.
2. Ship it anyway and plan the rollback as a database restore (`scripts/ops/restore.sh`). Every
   write since the backup is lost, so the release notes must say so before it ships.

## Rolling back

1. Redeploy the previous release's images. Its migrate step runs first and must print
   `No migrations to apply` — anything else means the database is not the one the drill checked.
   Stop there.
2. Check the stack from outside: `./scripts/ops/verify-deployment.sh <base-url>`.
3. Walk the golden path once by hand (sign in, upload, review, publish) — the drill covers the
   API and worker, not the web app against a live API.
4. Record what was rolled back, from which release to which, and the output of steps 1 and 2.

## What a rollback does not undo

- **Rows the newer release wrote stay.** Tables and columns the previous code does not know are
  ignored by it, not removed. Rolling forward again finds them as they were.
- **Anything already anchored stays on chain.** A rollback changes the software, not the chain.
- **The newer release's triggers and constraints stay in force.** They live in the database, so
  the previous code is held to them. A previous-release write path that does not satisfy them
  fails after the rollback — this is the most common drill failure.
