#!/usr/bin/env bash
#
# Rollback drill.
#
# A rollback redeploys the previous release's images onto a database that the newer release
# has already migrated. Migrations only go forward, so the question a rollback raises is not
# "does the old image start" but "does the old code still work on the new schema".
# This script answers it without a deployment platform:
#
#   1. a fresh database is migrated by TO_REF (the release being rolled back)
#   2. FROM_REF (the release rolled back to) runs its own migrate step on it — the same step its
#      image runs before the API starts. It must succeed without changing anything.
#   3. FROM_REF's API and worker test suites run against that database. They create their own
#      tenants, so they exercise the old code paths on the new schema.
#
# A failure in step 2 means the old image would not start. A failure in step 3 names the code
# path that breaks after a rollback — the fix is either a compatible migration in TO_REF or a
# rollback plan that restores the database too (see deploy/rollback.md).
#
# **It deletes nothing it did not create.** The database name carries the time and the script
# refuses if it already exists.
#
# Usage:
#   ADMIN_DATABASE_URL=postgres://postgres:...@127.0.0.1:5432/postgres \
#   FROM_REF=<previous release> TO_REF=<release being rolled back> \
#   ./scripts/ops/rollback-drill.sh
#
# ADMIN_DATABASE_URL must be able to CREATE DATABASE and CREATE ROLE — the test suites create
# their login roles. Never point it at a live cluster.

set -euo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required — a throwaway cluster that can create the drill database}"
: "${FROM_REF:?FROM_REF is required — the release rolled back to}"
: "${TO_REF:?TO_REF is required — the release being rolled back}"

root="$(cd "$(dirname "$0")/../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="${DRILL_DIR:-$(mktemp -d)}/rollback-$stamp"
db="mpc_rollback_$(printf '%s' "$stamp" | tr '[:upper:]' '[:lower:]')"
# `_` is a LIKE wildcard: escape every one in the name, not only the separator.
db_like="$(printf '%s' "$db" | sed 's/_/\\_/g')"
db_url="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E "s#/[^/?]+(\?|\$)#/$db\1#")"

from_sha="$(git -C "$root" rev-parse --verify "$FROM_REF^{commit}")"
to_sha="$(git -C "$root" rev-parse --verify "$TO_REF^{commit}")"

echo "Rollback drill $stamp"
echo "  from (rolled back to): $FROM_REF ${from_sha:0:7}"
echo "  to (rolled back):      $TO_REF ${to_sha:0:7}"
echo "  drill database:        $db"
echo "  work directory:        $work"
echo

cleanup_done=0
cleanup() {
  [ "$cleanup_done" = "1" ] && return
  cleanup_done=1
  if [ "${DRILL_KEEP:-}" = "1" ]; then
    echo
    echo "DRILL_KEEP=1 — keeping: database $db · $work"
    return
  fi
  # The worker suites derive their own databases from the drill database's name
  # (`<name>_outbox`, `<name>_notify`, …). They are the drill's too.
  psql "$ADMIN_DATABASE_URL" -tAc \
    "SELECT datname FROM pg_database WHERE datname = '$db' OR datname LIKE '${db_like}\_%'" 2>/dev/null \
    | while read -r name; do
        [ -n "$name" ] && psql "$ADMIN_DATABASE_URL" -q -c "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1
      done || true
  for side in from to; do
    [ -d "$work/$side" ] && git -C "$root" worktree remove --force "$work/$side" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

if psql "$ADMIN_DATABASE_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
  echo "Drill database already exists: $db" >&2
  exit 1
fi
psql "$ADMIN_DATABASE_URL" -q -c "CREATE DATABASE \"$db\""

mkdir -p "$work"
for side in from to; do
  sha="$from_sha"; [ "$side" = "to" ] && sha="$to_sha"
  git -C "$root" worktree add --detach "$work/$side" "$sha" >/dev/null 2>&1
  (cd "$work/$side" && pnpm install --frozen-lockfile --prefer-offline >"$work/$side-install.log" 2>&1)
done

# --- 1. The newer release migrates -------------------------------------------------
(cd "$work/to" && DATABASE_URL="$db_url" pnpm --silent --filter @mpc/db migrate) >"$work/to-migrate.log" 2>&1
to_count=$(psql "$db_url" -tAc "SELECT count(*) FROM core.schema_migrations")
from_files=$(cd "$work/from/packages/db/migrations" && ls ./*.sql | sed 's#^\./##' | sort)
newer=$(psql "$db_url" -tAc "SELECT name FROM core.schema_migrations ORDER BY name" \
  | grep -vxF "$from_files" | tr '\n' ' ' | sed 's/ $//' || true)
echo "Migrated by $TO_REF: $to_count migrations (unknown to $FROM_REF: ${newer:-none})"

# --- 2. The older release runs its own migrate step --------------------------------
if (cd "$work/from" && DATABASE_URL="$db_url" pnpm --silent --filter @mpc/db migrate) \
  >"$work/from-migrate.log" 2>&1; then
  if grep -q "No migrations to apply" "$work/from-migrate.log"; then
    from_migrate="passed, applied nothing"
  else
    from_migrate="**applied something** — $(tr '\n' ' ' <"$work/from-migrate.log")"
  fi
else
  from_migrate="**failed** — $(tail -3 "$work/from-migrate.log" | tr '\n' ' ')"
fi
echo "Migrate step of $FROM_REF: $from_migrate"

# --- 3. The older release's API and worker suites on the newer schema --------------
suite_status=0
(cd "$work/from" && DATABASE_URL="$db_url" npx vitest run --project @mpc/api --project @mpc/worker) \
  >"$work/from-suite.log" 2>&1 || suite_status=$?
files_line=$(grep -E '^ +Test Files' "$work/from-suite.log" | tail -1 | sed -E 's/^ +//' || true)
tests_line=$(grep -E '^ +Tests ' "$work/from-suite.log" | tail -1 | sed -E 's/^ +//' || true)
echo "Suites of $FROM_REF on the $TO_REF schema: ${tests_line:-no summary} (${files_line:-no summary})"

# --- 4. Report ---------------------------------------------------------------------
echo
echo "--- Rollback drill result ($stamp) ---"
echo
echo "| Step | Result |"
echo "|---|---|"
printf '| Refs | from %s `%s` → to %s `%s` |\n' "$FROM_REF" "${from_sha:0:7}" "$TO_REF" "${to_sha:0:7}"
printf '| Migrations applied by the newer release | %s (unknown to the older: %s) |\n' "$to_count" "${newer:-none}"
printf '| Older release migrate step | %s |\n' "$from_migrate"
printf '| Older API + worker suites on the newer schema | %s · %s |\n' "${tests_line:-no summary}" "${files_line:-no summary}"
echo

if [ "$suite_status" != "0" ]; then
  echo "Failing tests:"
  grep -E '^ +(FAIL|×) ' "$work/from-suite.log" | sed -E 's/^ +/  /' | sort -u | head -40
  echo
fi

case "$from_migrate" in
  passed*) ;;
  *) echo "Drill failed — the older release's migrate step does not pass on the newer schema" >&2; exit 1 ;;
esac
if [ "$suite_status" != "0" ]; then
  echo "Drill failed — older code paths break on the newer schema (full log kept with DRILL_KEEP=1)" >&2
  exit 1
fi
echo "Drill passed — $FROM_REF runs on the schema $TO_REF left behind"
