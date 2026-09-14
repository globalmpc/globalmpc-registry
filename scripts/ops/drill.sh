#!/usr/bin/env bash
#
# Restore drill.
#
# Runs `backup.sh` → `restore.sh` **to the end** and prints the result in a form a person can
# paste. A drill done by hand is done a little differently each time, and a drill done
# differently cannot be compared with the next one.
#
# **It deletes nothing.** It creates a fresh restore target DB and bucket, and refuses if they
# already exist. Pouring onto something live is not a drill; it is an incident.
#
# Usage:
#   DATABASE_URL=postgres://... \
#   ADMIN_DATABASE_URL=postgres://.../postgres \
#   OBJECT_BUCKET=mpc-evidence OBJECT_ENDPOINT=https://... \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#   ./drill.sh
#
# Why `ADMIN_DATABASE_URL` is separate: the restore target database **must be created**, and
# `CREATE DATABASE` only runs while connected to another database.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required — the source to back up}"
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required — the connection that creates the restore target}"
: "${OBJECT_BUCKET:?OBJECT_BUCKET is required — a drill without objects does not prove a restore}"

here="$(cd "$(dirname "$0")" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# S3 bucket names accept only lowercase. With the timestamp's `T`/`Z` left in, creation is
# rejected with `InvalidBucketName` — the drill stops right after the backup.
bucket_stamp="$(printf '%s' "$stamp" | tr '[:upper:]' '[:lower:]')"
work="${DRILL_DIR:-$(mktemp -d)}/drill-$stamp"
restore_db="mpc_drill_$stamp"
restore_bucket="${OBJECT_BUCKET}-drill-$bucket_stamp"

echo "Restore drill $stamp"
echo "  work directory:        $work"
echo "  restore target DB:     $restore_db"
echo "  restore target bucket: $restore_bucket"
echo

cleanup_done=0
cleanup() {
  [ "$cleanup_done" = "1" ] && return
  cleanup_done=1
  if [ "${DRILL_KEEP:-}" = "1" ]; then
    echo
    echo "DRILL_KEEP=1 — keeping: DB $restore_db · bucket $restore_bucket · $work"
    return
  fi
  echo
  echo "Cleaning up…"
  psql "$ADMIN_DATABASE_URL" -q -c "DROP DATABASE IF EXISTS \"$restore_db\"" >/dev/null 2>&1 || true
  aws s3 rb "s3://$restore_bucket" --force \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# --- 0. Record the source state first -----------------------------------------
#
# A drill result must be "**what** was restored", not just "it was restored".
source_migrations=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM core.schema_migrations")
source_audit=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM audit.events")
echo "Source: migration $source_migrations · audit.events $source_audit"

# --- 1. Backup -----------------------------------------------------------------
BACKUP_DIR="$work/backup" "$here/backup.sh" >/dev/null
echo "Backup done"

# --- 2. Create the restore target ----------------------------------------------
#
# Refuse if it already exists. The name contains the time, so a collision only happens when
# run twice in the same second, and stopping is right then.
if psql "$ADMIN_DATABASE_URL" -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$restore_db'" | grep -q 1; then
  echo "Restore target DB already exists: $restore_db" >&2
  exit 1
fi
psql "$ADMIN_DATABASE_URL" -q -c "CREATE DATABASE \"$restore_db\""
aws s3 mb "s3://$restore_bucket" \
  ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null

# Connect with the same host and credentials as the source; change only the database name.
target_url="$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?|\$)#/$restore_db\1#")"

# --- 3. Restore ----------------------------------------------------------------
TARGET_DATABASE_URL="$target_url" \
  BACKUP_DIR="$work/backup" \
  OBJECT_BUCKET="$restore_bucket" \
  "$here/restore.sh"

# --- 4. Compare what was restored with the source -------------------------------
#
# `restore.sh` also compares with the manifest, but that is against **backup time**. Here it
# is matched against the live source too — whether the backup is stale is also a drill result.
#
# **But equality is not required for `audit.events`** — 2026-09-10 audit A6.
# This table is append-only and grows while the backup runs. Requiring equality would make
# **a good backup fail the drill**, and that failure would misstate its reason. Production has
# no window where writes stop, so a verdict that passes only on a quiet DB is not a drill.
#
# Two things are checked instead.
#   - restored = manifest (was the snapshot restored as is — `restore.sh` already checks)
#   - restored ≤ current source (append-only did not go backwards)
restored_migrations=$(psql "$target_url" -tAc "SELECT count(*) FROM core.schema_migrations")
restored_audit=$(psql "$target_url" -tAc "SELECT count(*) FROM audit.events")
now_audit=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM audit.events")

# --- 5. Confirm it does not pour onto a live DB ----------------------------------
#
# Half of a drill is **not doing what must not be done**. A second restore must be refused.
guard_output=$(
  TARGET_DATABASE_URL="$target_url" BACKUP_DIR="$work/backup" \
    OBJECT_BUCKET="$restore_bucket" "$here/restore.sh" 2>&1 || true
)
if printf '%s' "$guard_output" | grep -q "is not empty"; then
  guard="refused"
else
  guard="**not refused — needs checking**"
fi

# --- 6. Report -----------------------------------------------------------------
echo
echo "--- Drill result ($stamp) — paste into LOG.md ---"
echo
echo "| Item | Source | Restored | Verdict |"
echo "|---|---|---|---|"
printf '| schema_migrations | %s | %s | %s |\n' "$source_migrations" "$restored_migrations" \
  "$([ "$source_migrations" = "$restored_migrations" ] && echo match || echo '**mismatch**')"
printf '| audit.events (source just before backup → restored, source now %s) | %s | %s | %s |\n' \
  "$now_audit" "$source_audit" "$restored_audit" \
  "$([ "$restored_audit" -le "$now_audit" ] && echo 'only grew' || echo '**went backwards**')"
printf '| Re-restore onto live DB | — | — | %s |\n' "$guard"
echo

if [ "$source_migrations" != "$restored_migrations" ]; then
  echo "Drill failed — the restored migrations differ from the source" >&2
  exit 1
fi
# If append-only goes backwards, the restored copy is not behind the source; it is **different
# data**. That is a defect, not backup lag.
if [ "$restored_audit" -gt "$now_audit" ]; then
  echo "Drill failed — the restored audit.events has more rows than the source" >&2
  exit 1
fi
if [ "$guard" != "refused" ]; then
  echo "Drill failed — a restore onto a live DB was allowed" >&2
  exit 1
fi

echo "Drill passed"
