#!/usr/bin/env bash
#
# 백업 — PostgreSQL + 객체저장소를 **한 단위로** 받는다.
#
# 둘을 따로 받으면 복구할 수 없다. DB에는 artifact 행이 있는데 객체가 없으면
# 증빙을 열 수 없고, 객체만 있으면 그것이 무엇의 증빙인지 알 수 없다. 그래서 이
# 스크립트는 둘을 같은 디렉터리에 넣고 하나의 manifest로 묶는다.
#
# 받지 않는 것: cluster role(`mpc_app_login`·`mpc_worker_login`)과 비밀. pg_dump는
# 데이터베이스 안의 것만 받는다. 복구할 때 role은 다시 만들어야 한다 — restore.sh가
# 그것을 확인한다.
#
# 사용:
#   DATABASE_URL=postgres://... BACKUP_DIR=/backups/2026-08-26T00-00-00Z ./backup.sh
#
# 객체저장소까지 받으려면 (선택이 아니라 운영에서는 필수):
#   OBJECT_ENDPOINT=https://... OBJECT_BUCKET=mpc-evidence \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./backup.sh

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL이 필요하다}"
: "${BACKUP_DIR:?BACKUP_DIR이 필요하다}"

if [ -e "$BACKUP_DIR" ]; then
  # 덮어쓰면 어느 시점의 백업인지 알 수 없게 된다. 시각을 디렉터리 이름에 넣는다.
  echo "BACKUP_DIR이 이미 있다: $BACKUP_DIR" >&2
  exit 1
fi

command -v pg_dump >/dev/null || { echo "pg_dump가 없다" >&2; exit 1; }

server_version=$(psql "$DATABASE_URL" -tAc "SHOW server_version_num")
server_major=$((server_version / 10000))
dump_major=$(pg_dump --version | sed -E 's/.*PostgreSQL\) ([0-9]+).*/\1/')

# pg_dump는 자기보다 **새로운** 서버를 받지 못한다. 받아도 되는 것처럼 실패하면
# 백업이 있다고 믿는 상태로 운영하게 된다.
if [ "$dump_major" -lt "$server_major" ]; then
  echo "pg_dump $dump_major 로 서버 $server_major 를 받을 수 없다" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# dump와 통계를 **같은 스냅숏에서** 뜬다 — 2026-09-10 실사 A6.
#
# 예전에는 `pg_dump` 뒤에 별도 연결로 `audit.events`를 셌다. 그 사이에 업무
# 이벤트가 하나라도 들어오면 dump의 행 수와 manifest의 행 수가 달라지고,
# **정상 dump가 복구 검증에서 실패한다.** 로컬의 조용한 복구 훈련은 그 조건을
# 만들지 않으므로 이 어긋남은 운영에서 처음 드러난다.
#
# 방법: 트랜잭션을 열어 스냅숏을 내보내고, 그 스냅숏으로 `pg_dump`를 돌리고,
# **같은 트랜잭션 안에서** 통계를 읽는다. `\!`는 psql이 트랜잭션을 연 채로
# 셸 명령을 돌리는 자리다.
#
# `\o`의 인자는 작은따옴표로 감싼다. psql 메타커맨드는 공백으로 인자를 나누므로
# 감싸지 않으면 `BACKUP_DIR`에 공백이 있을 때 파일이 엉뚱한 곳에 쓰인다.
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

# `\!`의 실패는 psql을 멈추지 않는다. 표시를 따로 본다 — 보지 않으면 빈
# dump에 통계만 붙은 백업이 성공으로 끝난다.
if [ -f "$dump_failed" ]; then
  echo "pg_dump가 실패했다" >&2
  exit 1
fi
[ -s "$BACKUP_DIR/db.dump" ] || { echo "db.dump가 비었다" >&2; exit 1; }

dump_sha=$(shasum -a 256 "$BACKUP_DIR/db.dump" | awk '{print $1}')
migrations=$(sed -n '1p' "$stats_file")
latest_migration=$(sed -n '2p' "$stats_file")
audit_events=$(sed -n '3p' "$stats_file")
rm -f "$snapshot_file" "$stats_file"

for value in "$migrations" "$latest_migration" "$audit_events"; do
  [ -n "$value" ] || { echo "스냅숏 통계를 읽지 못했다" >&2; exit 1; }
done

object_count="null"
object_bytes="null"
object_digest="null"
if [ -n "${OBJECT_BUCKET:-}" ]; then
  command -v aws >/dev/null || { echo "aws CLI가 없다 — 객체를 받을 수 없다" >&2; exit 1; }
  mkdir -p "$BACKUP_DIR/objects"
  aws s3 sync "s3://$OBJECT_BUCKET" "$BACKUP_DIR/objects" \
    ${OBJECT_ENDPOINT:+--endpoint-url "$OBJECT_ENDPOINT"} --only-show-errors
  object_count=$(find "$BACKUP_DIR/objects" -type f | wc -l | tr -d ' ')
  object_bytes=$(find "$BACKUP_DIR/objects" -type f -exec wc -c {} + \
    | tail -1 | awk '{print $1}')

  # 객체별 해시 — 2026-09-10 실사 A5.
  #
  # 개수와 바이트만으로는 **내용이 바뀐 것**을 잡지 못한다. 증빙이 조용히
  # 다른 파일로 바뀐 백업은 복구 뒤에도 정상으로 보인다.
  ( cd "$BACKUP_DIR/objects" && find . -type f -print0 \
      | sort -z | xargs -0 shasum -a 256 ) > "$BACKUP_DIR/objects.sha256"
  # 목록 자체가 바뀌는 것도 잡는다. manifest에 이 해시가 들어간다.
  object_digest="\"$(shasum -a 256 "$BACKUP_DIR/objects.sha256" | awk '{print $1}')\""
else
  # 객체 없이 받은 백업은 **복구용이 아니다.** manifest에 그 사실이 남는다.
  echo "OBJECT_BUCKET이 없다 — DB만 받는다. 이 백업으로는 증빙을 복구할 수 없다" >&2
fi

# JSON 값을 heredoc **밖에서** 만든다.
#
# 처음에는 `${OBJECT_BUCKET:+\"...\"}${OBJECT_BUCKET:-null}`을 heredoc 안에 뒀는데
# 두 분기가 **모두** 펼쳐져(`\"버킷\"버킷`) manifest가 JSON이 아니게 됐다. 게다가
# 인용되지 않은 heredoc에서 `\"`는 이스케이프가 아니라 역슬래시 그대로 나간다.
# 하필 객체를 함께 받은 경우 — 즉 **복구에 쓸 수 있는 유일한 백업** — 에서만
# 깨지므로 눈에 띄지 않았다.
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

# manifest가 JSON인지 **스스로 확인한다.**
#
# restore.sh는 이 파일을 grep으로 읽으므로 깨진 JSON에도 그럴듯한 값을 뽑아낸다.
# 즉 깨진 manifest는 복구할 때가 아니라 그 훨씬 뒤에 드러난다. 만든 자리에서
# 확인하면 백업이 실패로 끝나고, 그것이 옳은 결과다.
if command -v python3 >/dev/null; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$BACKUP_DIR/manifest.json" || {
    echo "manifest.json이 JSON이 아니다. 이 백업을 신뢰하지 않는다" >&2
    exit 1
  }
fi

echo "백업 완료: $BACKUP_DIR"
cat "$BACKUP_DIR/manifest.json"
