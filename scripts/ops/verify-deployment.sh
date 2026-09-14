#!/usr/bin/env bash
#
# 배포된 스택에 무엇이 켜져 있는지 밖에서 확인한다.
#
# 두 미결 항목은 "저장소 안에서 알 수 없다"로 열려 있었다. 실제로 알 수 없는
# 것은 **플랫폼 콘솔 설정**이고, 그 결과로 나타나는 **동작**은 밖에서 볼 수 있다.
# 이 스크립트는 볼 수 있는 것을 보고, 볼 수 없는 것은 무엇을 봐야 하는지 적는다.
#
#   ./verify-deployment.sh https://stg.example.test
#   LOAD_PROBE=1 ./verify-deployment.sh https://stg.example.test   # rate limit까지
#
# **읽기만 한다.** 기본 동작은 GET 몇 번이다. `LOAD_PROBE=1`일 때만 공개
# endpoint에 연속 요청을 보내며, 그것도 기본 60회다 — 운영 중 스택에 돌릴
# 것이므로 부하를 스스로 정하지 않는다.

set -euo pipefail

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  echo "사용법: $0 <base-url>   (예: https://stg.example.test)" >&2
  exit 2
fi
BASE="${BASE%/}"

LOAD_PROBE="${LOAD_PROBE:-0}"
LOAD_COUNT="${LOAD_COUNT:-60}"
CURL=(curl --silent --show-error --max-time 15)

pass=0
fail=0
unknown=0

say()   { printf '%s\n' "$*"; }
ok()    { printf '  [확인] %s\n' "$*"; pass=$((pass + 1)); }
bad()   { printf '  [문제] %s\n' "$*"; fail=$((fail + 1)); }
dunno() { printf '  [모름] %s\n' "$*"; unknown=$((unknown + 1)); }

say "대상: $BASE"
say ""

# ---------------------------------------------------------------------------
# 1. 살아 있는가
# ---------------------------------------------------------------------------
say "1. 기동 상태"

if ready="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/health/ready")"; then
  case "$ready" in
    200) ok "/health/ready 200" ;;
    *)   bad "/health/ready $ready — DB나 객체 저장소가 준비되지 않았다" ;;
  esac
else
  bad "/health/ready에 닿지 못했다"
fi

# ---------------------------------------------------------------------------
# 2. chain·scan 프로파일이 켜져 있는가
# ---------------------------------------------------------------------------
say ""
say "2. worker 프로파일"
say "   판단 근거: worker는 살아 있는 동안 core.worker_heartbeats에 신호를 남기고,"
say "   그것이 /metrics의 mpc_worker_seconds_since_heartbeat로 나온다."
say "   한 번도 신호를 남기지 않은 worker는 행이 아예 없다 — 0으로 내면"
say "   '방금 봤다'가 되므로 내지 않는다. 행이 없으면 그 프로파일은 꺼져 있다."

metrics="$("${CURL[@]}" "$BASE/metrics" || true)"

if [[ -z "$metrics" ]]; then
  dunno "/metrics를 읽지 못했다 — 보호돼 있으면 정상이다. 그때는 콘솔에서 확인한다"
else
  for kind in anchor scan outbox; do
    line="$(printf '%s\n' "$metrics" | grep -E "mpc_worker_seconds_since_heartbeat\{state=\"$kind\"\}" || true)"
    if [[ -z "$line" ]]; then
      case "$kind" in
        anchor) bad "anchor worker 신호 없음 — chain 프로파일이 꺼져 있다. batch가 제출되지 않는다" ;;
        scan)   bad "scan worker 신호 없음 — scan 프로파일이 꺼져 있다. 업로드가 quarantined에서 멈춘다" ;;
        *)      bad "$kind worker 신호 없음" ;;
      esac
    else
      seconds="${line##* }"
      # 신호가 오래됐으면 켜져 있다가 죽은 것이다. 꺼진 것과 구분해서 말한다.
      if (( ${seconds%.*} > 120 )); then
        bad "$kind worker 신호가 ${seconds}초 전 — 떠 있었으나 지금은 멈췄다"
      else
        ok "$kind worker 살아 있음 (${seconds}초 전)"
      fi
    fi
  done

  # `# TYPE mpc_uploads_quarantined gauge` 주석 줄을 빼지 않으면 값 대신
  # "gauge"가 잡힌다. Prometheus 텍스트 형식에서 주석은 `#`로 시작한다.
  quarantined="$(printf '%s\n' "$metrics" \
    | grep -E '^mpc_uploads_quarantined' | awk '{print $NF}' || true)"
  [[ -n "$quarantined" ]] && say "   참고: quarantined 업로드 $quarantined 건"
fi

# ---------------------------------------------------------------------------
# 3. 공개 API 앞단
# ---------------------------------------------------------------------------
say ""
say "3. 공개 API 앞단"

headers="$("${CURL[@]}" -D - -o /dev/null "$BASE/api/v1/public/disclosures?limit=1" || true)"

if printf '%s\n' "$headers" | grep -qiE '^cache-control:.*max-age'; then
  ok "공개 응답에 cache-control이 있다"
else
  bad "공개 응답에 cache-control이 없다 — 앞단 캐시가 붙어도 효과가 없다"
fi

# 앞단이 있는지는 헤더로만 추정한다. 단정하지 않는다.
if printf '%s\n' "$headers" | grep -qiE '^(server|via|x-served-by|cf-ray|x-vercel-id):'; then
  say "   앞단으로 보이는 헤더:"
  printf '%s\n' "$headers" | grep -iE '^(server|via|x-served-by|cf-ray|x-vercel-id):' | sed 's/^/     /'
  dunno "헤더만으로는 그것이 WAF인지 단순 reverse proxy인지 알 수 없다 — 콘솔 확인 필요"
else
  dunno "앞단을 가리키는 헤더가 없다 — 프록시가 없거나 헤더를 지운다"
fi

# 위조 X-Forwarded-For. 앱이 이것을 그대로 믿으면 IP 기준 제한이 무의미해진다.
# 밖에서는 신뢰 여부를 직접 볼 수 없다. 요청이 거절되지 않는다는 것만 확인하고
# 실제 판정은 로그 대조로 넘긴다 — 추정을 확인으로 바꾸지 않는다.
forged="$("${CURL[@]}" -o /dev/null -w '%{http_code}' \
  -H 'X-Forwarded-For: 203.0.113.9' \
  "$BASE/api/v1/public/disclosures?limit=1" || true)"
say "   위조 X-Forwarded-For 요청 → HTTP $forged"
dunno "앱이 그 값을 client IP로 채택했는지는 로그에서 본다. 203.0.113.9로 기록됐다면 TRUSTED_PROXY_HOPS가 실제 proxy 수보다 크다"

if [[ "$LOAD_PROBE" == "1" ]]; then
  say ""
  say "   rate limit 탐침 — $LOAD_COUNT회 연속 요청"
  limited=0
  for _ in $(seq 1 "$LOAD_COUNT"); do
    code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/v1/public/disclosures?limit=1" || true)"
    if [[ "$code" == "429" ]]; then limited=1; break; fi
  done
  if (( limited == 1 )); then
    ok "429가 나왔다 — 제한이 걸려 있다"
    say "     주의: 앱 제한은 프로세스 로컬이다. 복제본이 여럿이면 총 허용량은"
    say "     복제본 수만큼 늘어난다. 이 탐침은 그 구분을 하지 못한다"
  else
    dunno "$LOAD_COUNT회로는 429가 나오지 않았다 — 한도가 그보다 높거나 제한이 없다"
  fi
else
  say "   rate limit 탐침 생략 (LOAD_PROBE=1로 켠다)"
fi

# ---------------------------------------------------------------------------
# 4. 밖에서 못 보는 것
# ---------------------------------------------------------------------------
say ""
say "4. 콘솔에서만 볼 수 있는 것"
cat <<'NOTE'
   - COMPOSE_PROFILES 실제 값과 기동 컨테이너 목록 (위 2번은 결과만 본다)
   - Traefik/WAF가 /api/*를 public API로 분류하는가
   - 복제본 수. 앱 rate limit은 프로세스 로컬이라 이 수가 총 허용량을 정한다
   - 실제 proxy hop 수와 TRUSTED_PROXY_HOPS의 일치
   - 429 비율·SIWE 실패율·request IP 쏠림 알림이 실제로 걸려 있는가
NOTE

say ""
say "확인 $pass · 문제 $fail · 모름 $unknown"
say ""
say "이 결과를 배포 기록에 날짜와 함께 남긴다. 남기지 않으면 다음에"
say "같은 것을 다시 조사하게 된다."

# 모름은 실패가 아니다. 밖에서 알 수 없는 것을 실패로 세면 아무도 이 스크립트를
# 게이트로 쓰지 않는다.
(( fail == 0 ))
