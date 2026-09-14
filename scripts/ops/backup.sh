#!/usr/bin/env bash
#
# Backup — takes PostgreSQL and object storage **as one unit**.
#
# Taken separately, they cannot be restored. If the DB has artifact rows but the objects are
# missing, evidence cannot be opened; with only objects, nobody knows what they are evidence of.
# So this script puts both in one directory and binds them with a single manifest.
#
# Not taken: cluster roles (`mpc_app_login`, `mpc_worker_login`) and secrets. pg_dump takes
# only what is inside the database. Roles must be recreated on restore — restore.sh
# checks for that.
#
# Usage:
#   DATABASE_URL=postgres://... BACKUP_DIR=/backups/2026-08-26T00-00-00Z ./backup.sh
#
# To also take object storage (not optional in production — required):
#   OBJECT_ENDPOINT=https://... OBJECT_BUCKET=mpc-evidence \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./backup.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"

if [ -e "$BACKUP_DIR" ]; then
  # Overwriting would lose which point in time the backup is. Put the time in the directory name.
  echo "BACKUP_DIR already exists: $BACKUP_DIR" >&2
  exit 1
fi

command -v pg_dump >/dev/null || { echo "pg_dump not found" >&2; exit 1; }

server_version=$(psql "$DATABASE_URL" -tAc "SHOW server_version_num")
server_major=$((server_version / 10000))
dump_major=$(pg_dump --version | sed -E 's/.*PostgreSQL\) ([0-9]+).*/\1/')

# pg_dump cannot dump a server **newer** than itself. If that failed while looking like it
# worked, operations would run believing a backup exists.
if [ "$dump_major" -lt "$server_major" ]; then
  echo "pg_dump $dump_major cannot dump server $server_major" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Take the dump and the stats **from the same snapshot** — 2026-09-10 audit A6.
#
# Previously `audit.events` was counted over a separate connection after `pg_dump`. If even
# one business event arrived in between, the dump's row count and the manifest's differed,
# and **a good dump failed restore verification.** A quiet local restore drill never creates
# that condition, so the mismatch would first surface in production.
#
# Method: open a transaction and export its snapshot, run `pg_dump` with that snapshot, and
# read the stats **inside the same transaction**. `\!` is where psql runs a shell command
# while keeping the transaction open.
#
# `\o` arguments are single-quoted. psql meta-commands split arguments on whitespace, so
# unquoted, a space in `BACKUP_DIR` would write the file somewhere unexpected.
export DATABASE_URL

snapshot_file="$BACKUP_DIR/.snapshot"
stats_file="$BACKUP_DIR/.stats"
dump_failed="$BACKUP_DIR/.dump-failed"
rm -f "$dump_failed"

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<PSQL
\pset tuples_only on
\pset format unaligned
BEGIN ISOLATION LEVEL REPEATABLE READ;
\o '$snapshot_file'
SELECT pg_export_snapshot();
\o
\! pg_dump "\$DATABASE_URL" --format=custom --no-owner --no-privileges --snapshot="\$(cat '$snapshot_file')" --file '$BACKUP_DIR/db.dump' || touch '$dump_failed'
\o '$stats_file'
SELECT count(*) FROM core.schema_migrations;
SELECT name FROM core.schema_migrations ORDER BY name DESC LIMIT 1;
SELECT count(*) FROM audit.events;
\o
COMMIT;
PSQL

# A failing `\!` does not stop psql. Check the marker separately — otherwise a backup with
# an empty dump plus stats would end as a success.
if [ -f "$dump_failed" ]; then
  echo "pg_dump failed" >&2
  exit 1
fi
[ -s "$BACKUP_DIR/db.dump" ] || { echo "db.dump is empty" >&2; exit 1; }

dump_sha=$(shasum -a 256 "$BACKUP_DIR/db.dump" | awk '{print $1}')
migrations=$(sed -n '1p' "$stats_file")
latest_migration=$(sed -n '2p' "$stats_file")
audit_events=$(sed -n '3p' "$stats_file")
rm -f "$snapshot_file" "$stats_file"

for value in "$migrations" "$latest_migration" "$audit_events"; do
  [ -n "$value" ] || { echo "Could not read snapshot stats" >&2; exit 1; }
done

object_count="null"
object_bytes="null"
object_digest="null"
if [ -n "${OBJECT_BUCKET:-}" ]; then
  command -v aws >/dev/null || { echo "aws CLI not found — cannot take objects" >&2; exit 1; }
  mkdir -p "$BACKUP_DIR/objects"
  aws s3 sync "s3://$OBJECT_BUCKET" "$BACKUP_DIR/objects" \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} --only-show-errors
  object_count=$(find "$BACKUP_DIR/objects" -type f | wc -l | tr -d ' ')
  object_bytes=$(find "$BACKUP_DIR/objects" -type f -exec wc -c {} + \
    | tail -1 | awk '{print $1}')

  # Per-object hashes — 2026-09-10 audit A5.
  #
  # Count and bytes alone do not catch **changed contents**. A backup in which evidence was
  # silently swapped for another file still looks fine after restore.
  ( cd "$BACKUP_DIR/objects" && find . -type f -print0 \
      | sort -z | xargs -0 shasum -a 256 ) > "$BACKUP_DIR/objects.sha256"
  # Also catch changes to the list itself. The manifest includes this hash.
  object_digest="\"$(shasum -a 256 "$BACKUP_DIR/objects.sha256" | awk '{print $1}')\""
else
  # A backup taken without objects is **not usable for restore.** The manifest records that.
  echo "OBJECT_BUCKET not set — taking the DB only. Evidence cannot be restored from this backup" >&2
fi

# Build JSON values **outside** the heredoc.
#
# At first `${OBJECT_BUCKET:+\"...\"}${OBJECT_BUCKET:-null}` sat inside the heredoc, and
# **both** branches expanded (`\"bucket\"bucket`), so the manifest was not JSON. Worse, in
# an unquoted heredoc `\"` is not an escape; the backslash is emitted literally. It broke
# only when objects were taken too — i.e. **the only backup usable for restore** — so it
# went unnoticed.
if [ -n "${OBJECT_BUCKET:-}" ]; then
  object_bucket_json="\"$OBJECT_BUCKET\""
else
  object_bucket_json="null"
fi

cat > "$BACKUP_DIR/manifest.json" <<JSON
{
  "takenAt": "$taken_at",
  "serverVersionNum": $server_version,
  "dumpSha256": "$dump_sha",
  "schemaMigrations": $migrations,
  "latestMigration": "$latest_migration",
  "auditEvents": $audit_events,
  "objectBucket": $object_bucket_json,
  "objectCount": $object_count,
  "objectBytes": $object_bytes,
  "objectDigest": $object_digest,
  "complete": $([ -n "${OBJECT_BUCKET:-}" ] && echo true || echo false)
}
JSON

# The manifest **checks itself** for valid JSON.
#
# restore.sh reads this file with grep, so it extracts plausible values even from broken
# JSON. A broken manifest would surface not at restore but much later. Checking where it is
# made ends the backup as a failure, which is the correct outcome.
if command -v python3 >/dev/null; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$BACKUP_DIR/manifest.json" || {
    echo "manifest.json is not JSON. This backup is not trusted" >&2
    exit 1
  }
fi

echo "Backup done: $BACKUP_DIR"
cat "$BACKUP_DIR/manifest.json"
