#!/usr/bin/env bash
#
# 복구 훈련.
#
# `backup.sh` → `restore.sh`를 **끝까지** 돌리고 결과를 사람이 붙여 넣을 수 있는
# 형태로 낸다. 훈련을 손으로 하면 매번 조금씩 다르게 하게 되고, 다르게 한 훈련은
# 다음 훈련과 비교할 수 없다.
#
# **아무것도 지우지 않는다.** 복구 대상 DB와 버킷을 새로 만들고, 이미 있으면
# 거절한다. 살아 있는 것 위에 부으면 그것은 훈련이 아니라 사고다.
#
# 사용:
#   DATABASE_URL=postgres://... \
#   ADMIN_DATABASE_URL=postgres://.../postgres \
#   OBJECT_BUCKET=mpc-evidence OBJECT_ENDPOINT=https://... \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#   ./drill.sh
#
# `ADMIN_DATABASE_URL`이 따로 필요한 이유: 복구 대상 데이터베이스를 **만들어야**
# 하고, `CREATE DATABASE`는 다른 데이터베이스에 붙어 있어야 실행된다.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL이 필요하다 — 백업할 원본}"
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL이 필요하다 — 복구 대상을 만들 연결}"
: "${OBJECT_BUCKET:?OBJECT_BUCKET이 필요하다 — 객체 없는 훈련은 복구를 증명하지 않는다}"

here="$(cd "$(dirname "$0")" && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# S3 버킷 이름은 소문자만 받는다. 시각의 `T`·`Z`가 그대로 들어가면 생성이
# `InvalidBucketName`으로 거절된다 — 훈련이 백업 직후에 멈춘다.
bucket_stamp="$(printf '%s' "$stamp" | tr '[:upper:]' '[:lower:]')"
work="${DRILL_DIR:-$(mktemp -d)}/drill-$stamp"
restore_db="mpc_drill_$stamp"
restore_bucket="${OBJECT_BUCKET}-drill-$bucket_stamp"

echo "복구 훈련 $stamp"
echo "  작업 디렉터리: $work"
echo "  복구 대상 DB:  $restore_db"
echo "  복구 대상 버킷: $restore_bucket"
echo

cleanup_done=0
cleanup() {
  [ "$cleanup_done" = "1" ] && return
  cleanup_done=1
  if [ "${DRILL_KEEP:-}" = "1" ]; then
    echo
    echo "DRILL_KEEP=1 — 남긴다: DB $restore_db · 버킷 $restore_bucket · $work"
    return
  fi
  echo
  echo "정리 중…"
  psql "$ADMIN_DATABASE_URL" -q -c "DROP DATABASE IF EXISTS \"$restore_db\"" >/dev/null 2>&1 || true
  aws s3 rb "s3://$restore_bucket" --force \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# --- 0. 원본 상태를 먼저 적는다 ----------------------------------------------
#
# 훈련 결과는 "복구됐다"가 아니라 "**무엇이** 복구됐다"여야 한다.
source_migrations=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM core.schema_migrations")
source_audit=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM audit.events")
echo "원본: migration $source_migrations · audit.events $source_audit"

# --- 1. 백업 -----------------------------------------------------------------
BACKUP_DIR="$work/backup" "$here/backup.sh" >/dev/null
echo "백업 완료"

# --- 2. 복구 대상을 만든다 ----------------------------------------------------
#
# 이미 있으면 거절한다. 이름에 시각이 들어가므로 충돌은 같은 초에 두 번 돌린
# 경우뿐이고, 그때는 멈추는 것이 맞다.
if psql "$ADMIN_DATABASE_URL" -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$restore_db'" | grep -q 1; then
  echo "복구 대상 DB가 이미 있다: $restore_db" >&2
  exit 1
fi
psql "$ADMIN_DATABASE_URL" -q -c "CREATE DATABASE \"$restore_db\""
aws s3 mb "s3://$restore_bucket" \
  ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null

# 원본과 같은 호스트·자격으로 붙되 데이터베이스 이름만 바꾼다.
target_url="$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?|\$)#/$restore_db\1#")"

# --- 3. 복구 -----------------------------------------------------------------
TARGET_DATABASE_URL="$target_url" \
  BACKUP_DIR="$work/backup" \
  OBJECT_BUCKET="$restore_bucket" \
  "$here/restore.sh"

# --- 4. 복구된 것을 원본과 대조한다 -------------------------------------------
#
# `restore.sh`도 manifest와 대조하지만, 그것은 **백업 시점**과의 대조다. 여기서는
# 지금 살아 있는 원본과도 맞춘다 — 백업이 낡았는지도 훈련의 결과다.
#
# **다만 `audit.events`에 등호를 요구하지 않는다** — 2026-09-10 실사 A6.
# 이 표는 append-only이고 백업이 도는 동안에도 늘어난다. 등호를 요구하면
# **정상 백업이 훈련에서 실패하고**, 그 실패는 자기 사유를 잘못 말한다. 운영에서
# 쓰기가 멈추는 시간대는 없으므로 조용한 DB에서만 통과하는 판정은 훈련이 아니다.
#
# 대신 두 가지를 본다.
#   - 복구본 = manifest (스냅숏을 그대로 되돌렸는가 — `restore.sh`가 이미 본다)
#   - 복구본 ≤ 현재 원본 (append-only가 거꾸로 가지 않았는가)
restored_migrations=$(psql "$target_url" -tAc "SELECT count(*) FROM core.schema_migrations")
restored_audit=$(psql "$target_url" -tAc "SELECT count(*) FROM audit.events")
now_audit=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM audit.events")

# --- 5. 살아 있는 DB에 붓지 않는지 확인 ---------------------------------------
#
# 훈련의 절반은 **하지 말아야 할 것을 하지 않는지**다. 두 번째 복구는 거절돼야 한다.
guard_output=$(
  TARGET_DATABASE_URL="$target_url" BACKUP_DIR="$work/backup" \
    OBJECT_BUCKET="$restore_bucket" "$here/restore.sh" 2>&1 || true
)
if printf '%s' "$guard_output" | grep -q "비어 있지 않다"; then
  guard="거절함"
else
  guard="**거절하지 않았다 — 확인 필요**"
fi

# --- 6. 보고 -----------------------------------------------------------------
echo
echo "--- 훈련 결과 ($stamp) — LOG.md에 붙여 넣는다 ---"
echo
echo "| 항목 | 원본 | 복구본 | 판정 |"
echo "|---|---|---|---|"
printf '| schema_migrations | %s | %s | %s |\n' "$source_migrations" "$restored_migrations" \
  "$([ "$source_migrations" = "$restored_migrations" ] && echo 일치 || echo '**불일치**')"
printf '| audit.events (백업 직전 원본 → 복구본, 지금 원본 %s) | %s | %s | %s |\n' \
  "$now_audit" "$source_audit" "$restored_audit" \
  "$([ "$restored_audit" -le "$now_audit" ] && echo '증가만 함' || echo '**거꾸로 갔다**')"
printf '| 살아 있는 DB 재복구 | — | — | %s |\n' "$guard"
echo

if [ "$source_migrations" != "$restored_migrations" ]; then
  echo "훈련 실패 — 복구본의 마이그레이션이 원본과 다르다" >&2
  exit 1
fi
# append-only가 거꾸로 가면 복구본이 원본보다 뒤에 있는 것이 아니라 **다른
# 데이터**다. 그것은 백업 지연이 아니라 결함이다.
if [ "$restored_audit" -gt "$now_audit" ]; then
  echo "훈련 실패 — 복구본의 audit.events가 원본보다 많다" >&2
  exit 1
fi
if [ "$guard" != "거절함" ]; then
  echo "훈련 실패 — 살아 있는 DB에 복구가 허용됐다" >&2
  exit 1
fi

echo "훈련 통과"
