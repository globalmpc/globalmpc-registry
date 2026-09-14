#!/usr/bin/env bash
#
# Backup/restore drill — 2026-09-10 audit A5·A6.
#
# The conditions this script creates are the point.
#
# 1. **Take a backup while writes continue** (A6). A drill on a quiet DB never creates the
#    condition where `pg_dump` and the stats disagree. In production that condition is the
#    default.
# 2. **Attempt a restore from a 'complete backup' with no objects** (A5). Previously that
#    ended as "restore done".
# 3. **Actually download restored objects and compare them** (A5).
#
# Usage:
#   DATABASE_URL=postgres://... ./test-backup-restore.sh
#
# **Run it on a disposable DB.** This script inserts rows into `audit.events`, and that
# table is append-only and cannot be cleaned up (trigger in 0003). Never run it against production.
#
# To cover the object path too, provide S3-compatible storage. Without it only the DB path runs
# and the output says so — a skip is never reported as a pass.
#   OBJECT_ENDPOINT=http://127.0.0.1:9000 OBJECT_BUCKET=mpc-test \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./test-backup-restore.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
restore_db="mpc_restore_$(date +%s)"
writer_pid=""

cleanup() {
  [ -n "$writer_pid" ] && kill "$writer_pid" 2>/dev/null || true
  [ -n "$writer_pid" ] && wait "$writer_pid" 2>/dev/null || true
  psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS $restore_db" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

pass=0
fail=0
ok()   { echo "  pass — $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL — $1" >&2; fail=$((fail + 1)); }

echo "== Setup: schema and audit events"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM audit.events" >/dev/null || {
  echo "audit.events not found. Run migrations first" >&2
  exit 1
}

# Keep generating writes.
#
# `audit.events` is append-only and the app path has no UPDATE/DELETE. Rows growing here while
# a backup runs is the normal production state.
seed_tenant=$(psql "$DATABASE_URL" -X -tAc "SELECT id FROM core.tenants LIMIT 1")
if [ -z "$seed_tenant" ]; then
  echo "No tenant — cannot generate write load. Run the seed first" >&2
  exit 1
fi

# Repeat with `\watch` in one session. Starting psql fresh each time lets that cost dominate
# the interval so it may not overlap the backup window — then the drill passes without
# having created the condition.
#
# **`exec` is the key.** Without it, `$!` is the PID of the subshell running this function;
# killing it leaves the child psql alive and still INSERTing. The script ends with "pass"
# while rows keep growing behind it — that actually happened (61 rows in 3 seconds).
writer() {
  exec psql "$DATABASE_URL" -X -q >/dev/null 2>&1 <<SQL
INSERT INTO audit.events (tenant_id, command, resource_type, resource_id,
                          effective_role, correlation_id)
VALUES ('$seed_tenant', 'backup.drill', 'drill', gen_random_uuid(),
        'system', 'backup-drill');
\watch 0.05
SQL
}

echo "== 1. Take a backup while writes continue (A6)"
writer &
writer_pid=$!
sleep 0.5

BACKUP_DIR="$work/backup" DATABASE_URL="$DATABASE_URL" "$here/backup.sh" >/dev/null
before_kill=$(psql "$DATABASE_URL" -X -tAc "SELECT count(*) FROM audit.events")
kill "$writer_pid" 2>/dev/null || true
wait "$writer_pid" 2>/dev/null || true
writer_pid=""

# **Check it really stopped.**
#
# The count right after `kill` cannot be used as is — the last transaction may commit after
# it. Wait until the same value appears twice in a row. If it never settles, an orphan
# process remains, and every count below is unstable.
count_events() { psql "$DATABASE_URL" -X -tAc "SELECT count(*) FROM audit.events"; }

after_kill=$(count_events)
settled=0
for _ in $(seq 1 20); do
  sleep 0.5
  current=$(count_events)
  if [ "$current" = "$after_kill" ]; then settled=1; break; fi
  after_kill="$current"
done
if [ "$settled" != "1" ]; then
  echo "Write load did not stop — an orphan psql remains" >&2
  exit 1
fi
ok "write load stopped (same value twice at 0.5s interval: $after_kill)"

manifest_events=$(grep -o '"auditEvents": *[0-9]*' "$work/backup/manifest.json" | grep -o '[0-9]*')

# This check sees **whether the drill created the condition**. If no rows were added while
# the backup ran, the checks below tested a quiet DB, which was the old drill's problem.
if [ "$after_kill" -gt "$manifest_events" ]; then
  ok "writes kept arriving after the backup snapshot (manifest $manifest_events → now $after_kill)"
else
  bad "writes did not overlap the backup window — this drill did not create the condition"
fi

echo "== 2. Restore that backup into an empty DB (A6)"
psql "$DATABASE_URL" -X -q -c "CREATE DATABASE $restore_db" >/dev/null
target="${DATABASE_URL%/*}/$restore_db"

if BACKUP_DIR="$work/backup" TARGET_DATABASE_URL="$target" ALLOW_DB_ONLY=1 \
   "$here/restore.sh" > "$work/restore.log" 2>&1; then
  ok "a backup taken during writes passes restore verification"
else
  bad "a backup taken during writes failed restore verification"
  sed -n '1,40p' "$work/restore.log" >&2
fi

restored_events=$(psql "$target" -X -tAc "SELECT count(*) FROM audit.events")
if [ "$restored_events" = "$manifest_events" ]; then
  ok "restored row count matches the manifest ($restored_events)"
else
  bad "restored row count $restored_events differs from manifest $manifest_events"
fi

echo "== 3. A 'complete backup' without objects does not start a restore (A5)"
cp -R "$work/backup" "$work/fake-complete"
python3 - "$work/fake-complete/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
# A backup with no objects taken but complete flipped to true. This used to be "restore done".
data["complete"] = True
json.dump(data, open(path, "w"), ensure_ascii=False, indent=2)
PY
psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_2" >/dev/null 2>&1 || true
psql "$DATABASE_URL" -X -q -c "CREATE DATABASE ${restore_db}_2" >/dev/null

if BACKUP_DIR="$work/fake-complete" TARGET_DATABASE_URL="${DATABASE_URL%/*}/${restore_db}_2" \
   OBJECT_BUCKET="" "$here/restore.sh" > "$work/fake.log" 2>&1; then
  bad "a complete backup without objects ended as restore done"
else
  ok "a complete backup without objects is refused before restore"
fi
psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_2" >/dev/null 2>&1 || true

echo "== 4. Object integrity (A5)"
if [ -n "${OBJECT_BUCKET:-}" ]; then
  rm -rf "$work/obj-backup"
  BACKUP_DIR="$work/obj-backup" "$here/backup.sh" >/dev/null
  [ -f "$work/obj-backup/objects.sha256" ] && ok "object hash list is created" \
    || bad "objects.sha256 not found"

  # Silently alter one file. Corruption that passes if only count and bytes are checked.
  victim=$(find "$work/obj-backup/objects" -type f | head -1)
  if [ -n "$victim" ]; then
    printf 'tampered' >> "$victim"
    psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_3" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -X -q -c "CREATE DATABASE ${restore_db}_3" >/dev/null
    if BACKUP_DIR="$work/obj-backup" TARGET_DATABASE_URL="${DATABASE_URL%/*}/${restore_db}_3" \
       "$here/restore.sh" > "$work/tamper.log" 2>&1; then
      bad "a backup with an altered object ended as restore done"
    else
      ok "an altered object is caught before restore"
    fi
    psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_3" >/dev/null 2>&1 || true
  else
    echo "  skipped — no objects in the bucket"
  fi

  echo "== 5. Good objects are returned and actually downloaded and compared (A5)"
  rm -rf "$work/obj-backup2"
  BACKUP_DIR="$work/obj-backup2" "$here/backup.sh" >/dev/null

  # Restore into an empty bucket. Pouring into the original bucket makes "already there"
  # and "restored" indistinguishable.
  target_bucket="${OBJECT_BUCKET}-restored-$(date +%s)"
  aws s3 mb "s3://$target_bucket" \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null

  psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_4" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -X -q -c "CREATE DATABASE ${restore_db}_4" >/dev/null

  if BACKUP_DIR="$work/obj-backup2" TARGET_DATABASE_URL="${DATABASE_URL%/*}/${restore_db}_4" \
     OBJECT_BUCKET="$target_bucket" "$here/restore.sh" > "$work/objects.log" 2>&1; then
    ok "a restore including objects passes"
  else
    bad "a restore including objects failed"
    sed -n '1,40p' "$work/objects.log" >&2
  fi

  # Does the output state the checked scope? A pass without "how many were checked" says
  # nothing you can interpret.
  if grep -q "download-verified [1-9]" "$work/objects.log"; then
    ok "restored objects were actually downloaded and compared ($(grep -o 'download-verified [0-9]*' "$work/objects.log" | head -1))"
  else
    bad "no download-verification record"
    grep "Object restore" "$work/objects.log" >&2 || true
  fi

  aws s3 rb "s3://$target_bucket" --force \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_4" >/dev/null 2>&1 || true
else
  echo "  skipped — OBJECT_BUCKET not set. The object path was not checked"
fi

# **Rows the drill inserted cannot be deleted.**
#
# `audit.events` rejects DELETE/UPDATE with a trigger (0003) — superusers included.
# That is this table's design and is not bypassed for drill convenience. Instead, it reports how many rows it left.
drill_rows=$(psql "$DATABASE_URL" -X -tAc \
  "SELECT count(*) FROM audit.events WHERE correlation_id = 'backup-drill'")
echo
echo "Rows this drill left in audit.events: ${drill_rows} (append-only; cannot be deleted)"

echo
echo "pass $pass · fail $fail"
[ "$fail" = "0" ]
