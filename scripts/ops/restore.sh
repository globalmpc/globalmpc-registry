#!/usr/bin/env bash
#
# 복구 — 백업 디렉터리 하나를 **비어 있는** 데이터베이스에 되돌린다.
#
# **비어 있지 않으면 거절한다.** `audit.events`와 `chain.reorg_events`는 append-only이고
# 앱 경로에 UPDATE·DELETE가 없다. 살아 있는 DB에 dump를 부으면 그 두 테이블에 과거
# 기록이 덧붙어 "언제 무엇이 있었나"가 두 번 적힌다. 되돌릴 수 없는 것은 순서가
# 중요하다 — 새 DB에 붓고, 확인한 뒤, 연결을 옮긴다.
#
# 받지 않은 것을 복구하지도 않는다: cluster role(`mpc_app_login`·`mpc_worker_login`)은
# dump에 없다. 복구 후 별도로 만들어야 하며 이 스크립트가 그 사실을 확인한다.
#
# 사용:
#   BACKUP_DIR=/backups/... TARGET_DATABASE_URL=postgres://... ./restore.sh

set -euo pipefail

: "${BACKUP_DIR:?BACKUP_DIR이 필요하다}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL이 필요하다}"

manifest="$BACKUP_DIR/manifest.json"
[ -f "$manifest" ] || { echo "manifest.json이 없다: $manifest" >&2; exit 1; }
[ -f "$BACKUP_DIR/db.dump" ] || { echo "db.dump가 없다" >&2; exit 1; }

read_manifest() { grep -o "\"$1\": *[^,}]*" "$manifest" | head -1 | sed -E 's/.*: *"?([^"]*)"?.*/\1/'; }

expected_sha=$(read_manifest dumpSha256)
actual_sha=$(shasum -a 256 "$BACKUP_DIR/db.dump" | awk '{print $1}')
if [ "$expected_sha" != "$actual_sha" ]; then
  # 손상된 dump로 복구하면 부분 복구가 성공처럼 보인다.
  echo "db.dump 해시가 manifest와 다르다" >&2
  echo "  manifest: $expected_sha" >&2
  echo "  실제:     $actual_sha" >&2
  exit 1
fi

# 완전 백업의 요건을 **복구 전에** 본다 — 2026-09-10 실사 A5.
#
# 예전에는 `objects/`가 없거나 `OBJECT_BUCKET`이 비어 있으면 객체 복사 분기를
# **조용히 건너뛰고** 마지막에 "복구 완료"를 출력했다. DB만 살아 있고 증빙
# 파일은 없는 서비스가 정상 복구로 분류된다. 그 상태는 사고 대응 중에 발견되며,
# 그때는 이미 원본이 없다.
complete=$(read_manifest complete)

if [ "$complete" != "true" ]; then
  echo "이 백업은 객체저장소를 포함하지 않는다. 증빙은 복구되지 않는다." >&2
  [ "${ALLOW_DB_ONLY:-}" = "1" ] || {
    echo "그래도 진행하려면 ALLOW_DB_ONLY=1" >&2
    exit 1
  }
else
  # 완전 백업이라고 선언했으면 셋이 모두 있어야 한다. 하나라도 없으면 이
  # 디렉터리는 완전 백업이 아니다 — 복구를 **시작하지 않는다.**
  [ -d "$BACKUP_DIR/objects" ] || {
    echo "manifest는 complete인데 objects/가 없다. 이 백업으로 복구하지 않는다" >&2
    exit 1
  }
  [ -f "$BACKUP_DIR/objects.sha256" ] || {
    echo "객체 해시 목록(objects.sha256)이 없다. 무결성을 확인할 수 없다" >&2
    exit 1
  }
  [ -n "${OBJECT_BUCKET:-}" ] || {
    echo "완전 백업을 복구하려면 OBJECT_BUCKET이 필요하다" >&2
    echo "  증빙을 되돌릴 곳이 없으면 복구가 아니다." >&2
    exit 1
  }
  command -v aws >/dev/null || { echo "aws CLI가 없다 — 객체를 되돌릴 수 없다" >&2; exit 1; }

  # 목록 자체가 바뀌었는지 먼저 본다. 목록을 믿고 파일을 검사하면 목록을 고친
  # 공격·손상은 통과한다.
  expected_digest=$(read_manifest objectDigest)
  actual_digest=$(shasum -a 256 "$BACKUP_DIR/objects.sha256" | awk '{print $1}')
  if [ -n "$expected_digest" ] && [ "$expected_digest" != "$actual_digest" ]; then
    echo "objects.sha256이 manifest와 다르다" >&2
    exit 1
  fi

  # 로컬 파일이 백업 당시와 같은가. 개수·바이트만으로는 **내용이 바뀐 것**을
  # 잡지 못한다.
  ( cd "$BACKUP_DIR/objects" && shasum -a 256 -c "../objects.sha256" --quiet ) || {
    echo "백업 디렉터리의 객체가 목록과 다르다" >&2
    exit 1
  }

  manifest_objects=$(read_manifest objectCount)
  local_objects=$(find "$BACKUP_DIR/objects" -type f | wc -l | tr -d ' ')
  if [ "$manifest_objects" != "$local_objects" ]; then
    echo "객체 개수가 manifest와 다르다: 기대 $manifest_objects, 실제 $local_objects" >&2
    exit 1
  fi
fi

existing=$(psql "$TARGET_DATABASE_URL" -tAc \
  "SELECT count(*) FROM information_schema.schemata WHERE schema_name IN ('core','chain','audit')")
if [ "$existing" != "0" ]; then
  echo "대상 DB가 비어 있지 않다 (core·chain·audit 스키마가 $existing 개 있다)" >&2
  echo "새 데이터베이스를 만들어 복구한다. 살아 있는 DB에 붓지 않는다." >&2
  exit 1
fi

pg_restore --dbname "$TARGET_DATABASE_URL" --no-owner --no-privileges \
  --exit-on-error "$BACKUP_DIR/db.dump"

# 복구가 "끝났다"는 것과 "맞다"는 것은 다르다. manifest의 수치와 대조한다.
fail=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "불일치 — $label: 기대 $expected, 실제 $actual" >&2
    fail=1
  else
    echo "일치 — $label: $actual"
  fi
}

check "schema_migrations" "$(read_manifest schemaMigrations)" \
  "$(psql "$TARGET_DATABASE_URL" -tAc 'SELECT count(*) FROM core.schema_migrations')"
check "latestMigration" "$(read_manifest latestMigration)" \
  "$(psql "$TARGET_DATABASE_URL" -tAc 'SELECT name FROM core.schema_migrations ORDER BY name DESC LIMIT 1')"
check "audit.events" "$(read_manifest auditEvents)" \
  "$(psql "$TARGET_DATABASE_URL" -tAc 'SELECT count(*) FROM audit.events')"

[ "$fail" = "0" ] || { echo "복구 검증 실패" >&2; exit 1; }

if [ "$complete" = "true" ]; then
  aws s3 sync "$BACKUP_DIR/objects" "s3://$OBJECT_BUCKET" \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} --only-show-errors

  restored=$(aws s3 ls "s3://$OBJECT_BUCKET" --recursive \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} | wc -l | tr -d ' ')
  check "객체 개수" "$local_objects" "$restored"

  #
  # **실제로 내려받아 본다** — 2026-09-10 실사 A5.
  #
  # sync가 성공했다는 것과 증빙을 열 수 있다는 것은 다르다. 권한·정책·버킷
  # 설정이 어긋나면 목록은 보이는데 본문을 못 읽는 상태가 생기고, 그 상태는
  # 사고 대응 중에 처음 드러난다.
  #
  # 전수 확인은 큰 백업에서 비싸다. `RESTORE_VERIFY_SAMPLE`(기본 20)만큼
  # 내려받아 해시를 대조하고, **몇 건을 확인했는지 출력에 남긴다** — 확인한
  # 범위를 숨기지 않는 것이 요점이다.
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
      echo "복구된 객체를 내려받지 못했다: $key" >&2
      fail=1
      break
    }
    actual=$(shasum -a 256 "$tmp_object" | awk '{print $1}')
    if [ "$expected" != "$actual" ]; then
      echo "복구된 객체의 내용이 다르다: $key" >&2
      fail=1
      break
    fi
    verified=$((verified + 1))
  done < "$BACKUP_DIR/objects.sha256"

  rm -f "$tmp_object"
  trap - EXIT

  if [ "$local_objects" -gt 0 ] && [ "$verified" -eq 0 ]; then
    echo "복구된 객체를 한 건도 확인하지 못했다" >&2
    fail=1
  fi

  echo "객체 복구: ${local_objects}건 · 다운로드 대조 ${verified}건(표본 상한 ${sample_size})"
  [ "$fail" = "0" ] || { echo "객체 복구 검증 실패" >&2; exit 1; }
fi

# login role은 dump에 없다. 없는 채로 앱을 붙이면 기동에 실패한다.
missing_roles=$(psql "$TARGET_DATABASE_URL" -tAc \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('mpc_app_login','mpc_worker_login')")
if [ "$missing_roles" != "2" ]; then
  echo "" >&2
  echo "남은 일: login role이 없다($missing_roles/2). 앱을 붙이기 전에 만든다." >&2
  echo "  pnpm --filter @mpc/db login-roles  (또는 배포의 IAM·secret manager 절차)" >&2
fi

echo "복구 완료"
