#!/usr/bin/env bash
#
# 백업·복구 훈련 — 2026-09-10 실사 A5·A6.
#
# 이 스크립트가 만드는 조건이 요점이다.
#
# 1. **쓰기가 계속되는 동안 백업을 받는다**(A6). 조용한 DB에서의 훈련은
#    `pg_dump`와 통계가 어긋나는 조건을 만들지 않는다. 운영에서는 그 조건이
#    기본값이다.
# 2. **객체가 없는 '완전 백업'으로 복구를 시도한다**(A5). 예전에는 그것이
#    "복구 완료"로 끝났다.
# 3. **복구된 객체를 실제로 내려받아 대조한다**(A5).
#
# 사용:
#   DATABASE_URL=postgres://... ./test-backup-restore.sh
#
# **버릴 수 있는 DB에서 돌린다.** 이 스크립트는 `audit.events`에 행을 넣고 그
# 표는 append-only라 지울 수 없다(0003의 트리거). 운영 DB에 대고 돌리지 않는다.
#
# 객체 경로까지 보려면 S3 호환 저장소를 준다. 없으면 DB 경로만 돌고 그 사실을
# 출력에 적는다 — 건너뛴 것을 통과로 적지 않는다.
#   OBJECT_ENDPOINT=http://127.0.0.1:9000 OBJECT_BUCKET=mpc-test \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./test-backup-restore.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL이 필요하다}"

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
ok()   { echo "  통과 — $1"; pass=$((pass + 1)); }
bad()  { echo "  실패 — $1" >&2; fail=$((fail + 1)); }

echo "== 준비: 스키마와 감사 이벤트"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM audit.events" >/dev/null || {
  echo "audit.events가 없다. 먼저 마이그레이션을 돌린다" >&2
  exit 1
}

# 쓰기를 계속 만든다.
#
# `audit.events`는 append-only이고 앱 경로에 UPDATE·DELETE가 없다. 백업이 도는
# 동안 여기에 행이 늘어나는 것이 운영의 기본 상태다.
seed_tenant=$(psql "$DATABASE_URL" -X -tAc "SELECT id FROM core.tenants LIMIT 1")
if [ -z "$seed_tenant" ]; then
  echo "tenant가 없다 — 쓰기 부하를 만들 수 없다. 먼저 seed를 돌린다" >&2
  exit 1
fi

# 한 세션에서 `\watch`로 반복한다. 매번 psql을 새로 띄우면 그 비용이 간격을
# 지배해서 백업 창과 겹치지 않을 수 있다 — 그러면 훈련이 조건을 만들지 못한 채
# 통과한다.
#
# **`exec`가 핵심이다.** 없으면 `$!`는 이 함수를 도는 서브셸의 PID이고, 그것을
# 죽여도 자식 psql은 살아남아 계속 INSERT한다. 스크립트는 "통과"로 끝나는데
# 뒤에서 행이 계속 늘어난다 — 실제로 그랬다(3초에 61행).
writer() {
  exec psql "$DATABASE_URL" -X -q >/dev/null 2>&1 <<SQL
INSERT INTO audit.events (tenant_id, command, resource_type, resource_id,
                          effective_role, correlation_id)
VALUES ('$seed_tenant', 'backup.drill', 'drill', gen_random_uuid(),
        'system', 'backup-drill');
\watch 0.05
SQL
}

echo "== 1. 쓰기가 계속되는 동안 백업을 받는다 (A6)"
writer &
writer_pid=$!
sleep 0.5

BACKUP_DIR="$work/backup" DATABASE_URL="$DATABASE_URL" "$here/backup.sh" >/dev/null
before_kill=$(psql "$DATABASE_URL" -X -tAc "SELECT count(*) FROM audit.events")
kill "$writer_pid" 2>/dev/null || true
wait "$writer_pid" 2>/dev/null || true
writer_pid=""

# **정말 멈췄는지 본다.**
#
# `kill` 직후의 수치를 그대로 쓰면 안 된다 — 마지막 트랜잭션이 그 뒤에 커밋될 수
# 있다. 두 번 연속 같은 값이 나올 때까지 기다린다. 끝내 안정되지 않으면 고아
# 프로세스가 남은 것이고, 그 상태에서는 아래 수치가 전부 흔들린다.
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
  echo "쓰기 부하가 멈추지 않았다 — 고아 psql이 남아 있다" >&2
  exit 1
fi
ok "쓰기 부하가 멈췄다 (0.5초 간격 두 번 $after_kill)"

manifest_events=$(grep -o '"auditEvents": *[0-9]*' "$work/backup/manifest.json" | grep -o '[0-9]*')

# 이 확인은 **훈련이 조건을 만들었는가**를 본다. 백업이 도는 동안 행이 늘지
# 않았다면 아래 검증들은 조용한 DB를 시험한 것이고, 그것이 예전 훈련의 문제였다.
if [ "$after_kill" -gt "$manifest_events" ]; then
  ok "백업 스냅숏 이후에도 쓰기가 들어왔다 (manifest $manifest_events → 현재 $after_kill)"
else
  bad "백업 창에 쓰기가 겹치지 않았다 — 이 훈련은 조건을 만들지 못했다"
fi

echo "== 2. 그 백업을 빈 DB로 되돌린다 (A6)"
psql "$DATABASE_URL" -X -q -c "CREATE DATABASE $restore_db" >/dev/null
target="${DATABASE_URL%/*}/$restore_db"

if BACKUP_DIR="$work/backup" TARGET_DATABASE_URL="$target" ALLOW_DB_ONLY=1 \
   "$here/restore.sh" > "$work/restore.log" 2>&1; then
  ok "쓰기 중 받은 백업이 복구 검증을 통과한다"
else
  bad "쓰기 중 받은 백업이 복구 검증에서 실패했다"
  sed -n '1,40p' "$work/restore.log" >&2
fi

restored_events=$(psql "$target" -X -tAc "SELECT count(*) FROM audit.events")
if [ "$restored_events" = "$manifest_events" ]; then
  ok "복구된 행 수가 manifest와 같다 ($restored_events)"
else
  bad "복구된 행 수 $restored_events 가 manifest $manifest_events 와 다르다"
fi

echo "== 3. 객체 없는 '완전 백업'은 복구를 시작하지 않는다 (A5)"
cp -R "$work/backup" "$work/fake-complete"
python3 - "$work/fake-complete/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
# 객체를 받지 않았는데 complete만 참으로 바꾼 백업. 예전에는 이것이 "복구 완료"였다.
data["complete"] = True
json.dump(data, open(path, "w"), ensure_ascii=False, indent=2)
PY
psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_2" >/dev/null 2>&1 || true
psql "$DATABASE_URL" -X -q -c "CREATE DATABASE ${restore_db}_2" >/dev/null

if BACKUP_DIR="$work/fake-complete" TARGET_DATABASE_URL="${DATABASE_URL%/*}/${restore_db}_2" \
   OBJECT_BUCKET="" "$here/restore.sh" > "$work/fake.log" 2>&1; then
  bad "객체 없는 완전 백업이 복구 완료로 끝났다"
else
  ok "객체 없는 완전 백업을 복구 전에 거절한다"
fi
psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_2" >/dev/null 2>&1 || true

echo "== 4. 객체 무결성 (A5)"
if [ -n "${OBJECT_BUCKET:-}" ]; then
  rm -rf "$work/obj-backup"
  BACKUP_DIR="$work/obj-backup" "$here/backup.sh" >/dev/null
  [ -f "$work/obj-backup/objects.sha256" ] && ok "객체 해시 목록이 만들어진다" \
    || bad "objects.sha256이 없다"

  # 파일 하나를 조용히 바꾼다. 개수·바이트만 보면 통과하는 손상이다.
  victim=$(find "$work/obj-backup/objects" -type f | head -1)
  if [ -n "$victim" ]; then
    printf 'tampered' >> "$victim"
    psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_3" >/dev/null 2>&1 || true
    psql "$DATABASE_URL" -X -q -c "CREATE DATABASE ${restore_db}_3" >/dev/null
    if BACKUP_DIR="$work/obj-backup" TARGET_DATABASE_URL="${DATABASE_URL%/*}/${restore_db}_3" \
       "$here/restore.sh" > "$work/tamper.log" 2>&1; then
      bad "내용이 바뀐 객체를 가진 백업이 복구 완료로 끝났다"
    else
      ok "내용이 바뀐 객체를 복구 전에 잡는다"
    fi
    psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_3" >/dev/null 2>&1 || true
  else
    echo "  건너뜀 — 버킷에 객체가 없다"
  fi

  echo "== 5. 정상 객체는 되돌아가고 실제로 내려받아 대조된다 (A5)"
  rm -rf "$work/obj-backup2"
  BACKUP_DIR="$work/obj-backup2" "$here/backup.sh" >/dev/null

  # 빈 버킷으로 되돌린다. 원래 버킷에 부으면 "이미 있던 것"과 "복구된 것"이
  # 구분되지 않는다.
  target_bucket="${OBJECT_BUCKET}-restored-$(date +%s)"
  aws s3 mb "s3://$target_bucket" \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null

  psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_4" >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -X -q -c "CREATE DATABASE ${restore_db}_4" >/dev/null

  if BACKUP_DIR="$work/obj-backup2" TARGET_DATABASE_URL="${DATABASE_URL%/*}/${restore_db}_4" \
     OBJECT_BUCKET="$target_bucket" "$here/restore.sh" > "$work/objects.log" 2>&1; then
    ok "객체를 포함한 복구가 통과한다"
  else
    bad "객체를 포함한 복구가 실패했다"
    sed -n '1,40p' "$work/objects.log" >&2
  fi

  # 확인한 범위를 출력이 밝히는가. "몇 건을 봤는지" 없이 통과하면 그 통과는
  # 무엇을 말하는지 알 수 없다.
  if grep -q "다운로드 대조 [1-9]" "$work/objects.log"; then
    ok "복구된 객체를 실제로 내려받아 대조했다 ($(grep -o '다운로드 대조 [0-9]*건' "$work/objects.log" | head -1))"
  else
    bad "다운로드 대조 기록이 없다"
    grep "객체 복구" "$work/objects.log" >&2 || true
  fi

  aws s3 rb "s3://$target_bucket" --force \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} >/dev/null 2>&1 || true
  psql "$DATABASE_URL" -X -q -c "DROP DATABASE IF EXISTS ${restore_db}_4" >/dev/null 2>&1 || true
else
  echo "  건너뜀 — OBJECT_BUCKET이 없다. 객체 경로는 확인하지 않았다"
fi

# **훈련이 넣은 행은 지울 수 없다.**
#
# `audit.events`는 트리거로 DELETE·UPDATE를 거절한다(0003) — superuser도 마찬가지다.
# 그것이 이 표의 설계이며 훈련 편의로 뚫지 않는다. 대신 몇 행을 남겼는지 말한다.
drill_rows=$(psql "$DATABASE_URL" -X -tAc \
  "SELECT count(*) FROM audit.events WHERE correlation_id = 'backup-drill'")
echo
echo "이 훈련이 audit.events에 남긴 행: ${drill_rows} (append-only라 지울 수 없다)"

echo
echo "통과 $pass · 실패 $fail"
[ "$fail" = "0" ]
