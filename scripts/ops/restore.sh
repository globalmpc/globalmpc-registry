#!/usr/bin/env bash
#
# Restore — returns one backup directory into an **empty** database.
#
# **Refuses if not empty.** `audit.events` and `chain.reorg_events` are append-only, and the
# app path has no UPDATE/DELETE. Pouring a dump onto a live DB appends past records to those
# two tables, so "what existed when" is written twice. For the irreversible, order
# matters — pour into a new DB, verify, then switch connections.
#
# It does not restore what was not taken: cluster roles (`mpc_app_login`, `mpc_worker_login`)
# are not in the dump. They must be created separately after restore; this script checks that.
#
# Usage:
#   BACKUP_DIR=/backups/... TARGET_DATABASE_URL=postgres://... ./restore.sh

set -euo pipefail

: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"

manifest="$BACKUP_DIR/manifest.json"
[ -f "$manifest" ] || { echo "manifest.json not found: $manifest" >&2; exit 1; }
[ -f "$BACKUP_DIR/db.dump" ] || { echo "db.dump not found" >&2; exit 1; }

read_manifest() { grep -o "\"$1\": *[^,}]*" "$manifest" | head -1 | sed -E 's/.*: *"?([^"]*)"?.*/\1/'; }

expected_sha=$(read_manifest dumpSha256)
actual_sha=$(shasum -a 256 "$BACKUP_DIR/db.dump" | awk '{print $1}')
if [ "$expected_sha" != "$actual_sha" ]; then
  # Restoring from a corrupted dump makes a partial restore look like success.
  echo "db.dump hash differs from the manifest" >&2
  echo "  manifest: $expected_sha" >&2
  echo "  actual:   $actual_sha" >&2
  exit 1
fi

# Check the requirements of a complete backup **before restoring** — 2026-09-10 audit A5.
#
# Previously, when `objects/` was missing or `OBJECT_BUCKET` was empty, the object copy branch
# was **silently skipped** and "restore done" printed at the end. A service with only the DB
# alive and no evidence files was classified as a good restore. That state is found during
# incident response, when the original is already gone.
complete=$(read_manifest complete)

if [ "$complete" != "true" ]; then
  echo "This backup does not include object storage. Evidence will not be restored." >&2
  [ "${ALLOW_DB_ONLY:-}" = "1" ] || {
    echo "To proceed anyway, set ALLOW_DB_ONLY=1" >&2
    exit 1
  }
else
  # A backup declared complete must have all three. If any is missing, this directory is
  # not a complete backup — the restore **does not start.**
  [ -d "$BACKUP_DIR/objects" ] || {
    echo "manifest says complete but objects/ is missing. Not restoring from this backup" >&2
    exit 1
  }
  [ -f "$BACKUP_DIR/objects.sha256" ] || {
    echo "Object hash list (objects.sha256) is missing. Integrity cannot be verified" >&2
    exit 1
  }
  [ -n "${OBJECT_BUCKET:-}" ] || {
    echo "OBJECT_BUCKET is required to restore a complete backup" >&2
    echo "  Without a place to return evidence to, it is not a restore." >&2
    exit 1
  }
  command -v aws >/dev/null || { echo "aws CLI not found — cannot return objects" >&2; exit 1; }

  # First check whether the list itself changed. Trusting the list to check files lets
  # an attack or corruption that edits the list pass.
  expected_digest=$(read_manifest objectDigest)
  actual_digest=$(shasum -a 256 "$BACKUP_DIR/objects.sha256" | awk '{print $1}')
  if [ -n "$expected_digest" ] && [ "$expected_digest" != "$actual_digest" ]; then
    echo "objects.sha256 differs from the manifest" >&2
    exit 1
  fi

  # Are the local files the same as at backup time? Count and bytes alone do not catch
  # **changed contents**.
  ( cd "$BACKUP_DIR/objects" && shasum -a 256 -c "../objects.sha256" --quiet ) || {
    echo "Objects in the backup directory differ from the list" >&2
    exit 1
  }

  manifest_objects=$(read_manifest objectCount)
  local_objects=$(find "$BACKUP_DIR/objects" -type f | wc -l | tr -d ' ')
  if [ "$manifest_objects" != "$local_objects" ]; then
    echo "Object count differs from the manifest: expected $manifest_objects, actual $local_objects" >&2
    exit 1
  fi
fi

existing=$(psql "$TARGET_DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.schemata WHERE schema_name IN ('core','chain','audit')")
if [ "$existing" != "0" ]; then
  echo "Target DB is not empty ($existing of the core/chain/audit schemas exist)" >&2
  echo "Restore into a newly created database. Do not pour onto a live DB." >&2
  exit 1
fi

pg_restore --dbname "$TARGET_DATABASE_URL" --no-owner --no-privileges \
  --exit-on-error "$BACKUP_DIR/db.dump"

# A restore having "finished" differs from it being "correct". Compare with manifest values.
fail=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "mismatch — $label: expected $expected, actual $actual" >&2
    fail=1
  else
    echo "match — $label: $actual"
  fi
}

check "schema_migrations" "$(read_manifest schemaMigrations)" \
  "$(psql "$TARGET_DATABASE_URL" -tAc 'SELECT count(*) FROM core.schema_migrations')"
check "latestMigration" "$(read_manifest latestMigration)" \
  "$(psql "$TARGET_DATABASE_URL" -tAc 'SELECT name FROM core.schema_migrations ORDER BY name DESC LIMIT 1')"
check "audit.events" "$(read_manifest auditEvents)" \
  "$(psql "$TARGET_DATABASE_URL" -tAc 'SELECT count(*) FROM audit.events')"

[ "$fail" = "0" ] || { echo "Restore verification failed" >&2; exit 1; }

if [ "$complete" = "true" ]; then
  aws s3 sync "$BACKUP_DIR/objects" "s3://$OBJECT_BUCKET" \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} --only-show-errors

  restored=$(aws s3 ls "s3://$OBJECT_BUCKET" --recursive \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} | wc -l | tr -d ' ')
  check "object count" "$local_objects" "$restored"

  #
  # **Actually download them** — 2026-09-10 audit A5.
  #
  # A successful sync is not the same as evidence being openable. If permissions, policies,
  # or bucket settings are off, listings show but bodies cannot be read, and that state
  # first surfaces during incident response.
  #
  # Full verification is expensive for large backups. Download `RESTORE_VERIFY_SAMPLE`
  # (default 20) and compare hashes, and **record in the output how many were checked** — not
  # hiding the checked scope is the point.
  sample_size="${RESTORE_VERIFY_SAMPLE:-20}"
  verified=0
  tmp_object=$(mktemp)
  trap 'rm -f "$tmp_object"' EXIT

  while IFS= read -r line; do
    [ "$verified" -lt "$sample_size" ] || break
    expected=$(echo "$line" | awk '{print $1}')
    relative=$(echo "$line" | sed -E 's/^[0-9a-f]+ [ *]//')
    key="${relative#./}"

    aws s3 cp "s3://$OBJECT_BUCKET/$key" "$tmp_object" \
      ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} --only-show-errors || {
      echo "Could not download restored object: $key" >&2
      fail=1
      break
    }
    actual=$(shasum -a 256 "$tmp_object" | awk '{print $1}')
    if [ "$expected" != "$actual" ]; then
      echo "Restored object content differs: $key" >&2
      fail=1
      break
    fi
    verified=$((verified + 1))
  done < "$BACKUP_DIR/objects.sha256"

  rm -f "$tmp_object"
  trap - EXIT

  if [ "$local_objects" -gt 0 ] && [ "$verified" -eq 0 ]; then
    echo "Could not verify a single restored object" >&2
    fail=1
  fi

  echo "Object restore: ${local_objects} objects · download-verified ${verified} (sample cap ${sample_size})"
  [ "$fail" = "0" ] || { echo "Object restore verification failed" >&2; exit 1; }
fi

# login roles are not in the dump. Attaching the app without them fails at startup.
missing_roles=$(psql "$TARGET_DATABASE_URL" -tAc \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('mpc_app_login','mpc_worker_login')")
if [ "$missing_roles" != "2" ]; then
  echo "" >&2
  echo "Remaining: login roles are missing ($missing_roles/2). Create them before attaching the app." >&2
  echo "  pnpm --filter @mpc/db login-roles  (or the deployment's IAM/secret manager procedure)" >&2
fi

echo "Restore done"
