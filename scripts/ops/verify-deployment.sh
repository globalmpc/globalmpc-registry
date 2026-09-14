#!/usr/bin/env bash
#
# Checks from the outside what is turned on in a deployed stack.
#
# Two open items were left as "cannot be known from inside the repository". What truly cannot
# be known is the **platform console settings**; the **behavior** they produce is visible from
# outside. This script checks what is visible and, for what is not, notes what to look at.
#
#   ./verify-deployment.sh https://stg.example.test
#   LOAD_PROBE=1 ./verify-deployment.sh https://stg.example.test   # including rate limit
#
# **Read-only.** By default it makes a few GETs. Only with `LOAD_PROBE=1` does it send
# consecutive requests to a public endpoint, 60 by default — it runs against a live stack,
# so it does not decide the load on its own.

set -euo pipefail

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  echo "Usage: $0 <base-url>   (e.g. https://stg.example.test)" >&2
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
ok()    { printf '  [ok]      %s\n' "$*"; pass=$((pass + 1)); }
bad()   { printf '  [problem] %s\n' "$*"; fail=$((fail + 1)); }
dunno() { printf '  [unknown] %s\n' "$*"; unknown=$((unknown + 1)); }

say "Target: $BASE"
say ""

# ---------------------------------------------------------------------------
# 1. Is it alive?
# ---------------------------------------------------------------------------
say "1. Startup state"

if ready="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/health/ready")"; then
  case "$ready" in
    200) ok "/health/ready 200" ;;
    *)   bad "/health/ready $ready — the DB or object storage is not ready" ;;
  esac
else
  bad "Could not reach /health/ready"
fi

# ---------------------------------------------------------------------------
# 2. Are the chain and scan profiles on?
# ---------------------------------------------------------------------------
say ""
say "2. Worker profiles"
say "   Basis: while alive, a worker leaves signals in core.worker_heartbeats,"
say "   which appear in /metrics as mpc_worker_seconds_since_heartbeat."
say "   A worker that never signalled has no row at all — emitting 0 would mean"
say "   'just seen', so nothing is emitted. No row means that profile is off."

metrics="$("${CURL[@]}" "$BASE/metrics" || true)"

if [[ -z "$metrics" ]]; then
  dunno "Could not read /metrics — normal if it is protected. Check in the console then"
else
  for kind in anchor scan outbox; do
    line="$(printf '%s\n' "$metrics" | grep -E "mpc_worker_seconds_since_heartbeat\{state=\"$kind\"\}" || true)"
    if [[ -z "$line" ]]; then
      case "$kind" in
        anchor) bad "No anchor worker signal — the chain profile is off. Batches are not submitted" ;;
        scan)   bad "No scan worker signal — the scan profile is off. Uploads stall in quarantined" ;;
        *)      bad "No $kind worker signal" ;;
      esac
    else
      seconds="${line##* }"
      # A stale signal means it was on and then died. Report it separately from off.
      if (( ${seconds%.*} > 120 )); then
        bad "$kind worker signal ${seconds}s ago — it was up but has stopped"
      else
        ok "$kind worker alive (${seconds}s ago)"
      fi
    fi
  done

  # Unless the `# TYPE mpc_uploads_quarantined gauge` comment line is excluded, "gauge" is
  # captured instead of the value. In the Prometheus text format comments start with `#`.
  quarantined="$(printf '%s\n' "$metrics" \
    | grep -E '^mpc_uploads_quarantined' | awk '{print $NF}' || true)"
  [[ -n "$quarantined" ]] && say "   Note: $quarantined quarantined uploads"
fi

# ---------------------------------------------------------------------------
# 3. Public API front end
# ---------------------------------------------------------------------------
say ""
say "3. Public API front end"

headers="$("${CURL[@]}" -D - -o /dev/null "$BASE/api/v1/public/disclosures?limit=1" || true)"

if printf '%s\n' "$headers" | grep -qiE '^cache-control:.*max-age'; then
  ok "Public responses carry cache-control"
else
  bad "Public responses lack cache-control — a front-end cache would have no effect"
fi

# Whether a front end exists is only inferred from headers. Not asserted.
if printf '%s\n' "$headers" | grep -qiE '^(server|via|x-served-by|cf-ray|x-vercel-id):'; then
  say "   Headers suggesting a front end:"
  printf '%s\n' "$headers" | grep -iE '^(server|via|x-served-by|cf-ray|x-vercel-id):' | sed 's/^/     /'
  dunno "Headers alone cannot tell a WAF from a plain reverse proxy — check the console"
else
  dunno "No headers point to a front end — either no proxy, or it strips headers"
fi

# Forged X-Forwarded-For. If the app trusts it as is, IP-based limits become meaningless.
# Trust cannot be observed directly from outside. Only check that the request is not refused
# and leave the real verdict to log comparison — an inference is not turned into a confirmation.
forged="$("${CURL[@]}" -o /dev/null -w '%{http_code}' \
  -H 'X-Forwarded-For: 203.0.113.9' \
  "$BASE/api/v1/public/disclosures?limit=1" || true)"
say "   Forged X-Forwarded-For request → HTTP $forged"
dunno "Check the logs for whether the app took that value as the client IP. If 203.0.113.9 was recorded, TRUSTED_PROXY_HOPS exceeds the real proxy count"

if [[ "$LOAD_PROBE" == "1" ]]; then
  say ""
  say "   Rate limit probe — $LOAD_COUNT consecutive requests"
  limited=0
  for _ in $(seq 1 "$LOAD_COUNT"); do
    code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/v1/public/disclosures?limit=1" || true)"
    if [[ "$code" == "429" ]]; then limited=1; break; fi
  done
  if (( limited == 1 )); then
    ok "Got 429 — a limit is in place"
    say "     Caution: the app limit is process-local. With multiple replicas the total allowance"
    say "     grows by the replica count. This probe cannot tell the difference"
  else
    dunno "No 429 within $LOAD_COUNT requests — the limit is higher than that or absent"
  fi
else
  say "   Rate limit probe skipped (enable with LOAD_PROBE=1)"
fi

# ---------------------------------------------------------------------------
# 4. What cannot be seen from outside
# ---------------------------------------------------------------------------
say ""
say "4. Visible only in the console"
cat <<'NOTE'
   - The actual COMPOSE_PROFILES value and the list of running containers (step 2 above sees only the effect)
   - Whether Traefik/WAF classifies /api/* as the public API
   - Replica count. The app rate limit is process-local, so this number sets the total allowance
   - Whether the real proxy hop count matches TRUSTED_PROXY_HOPS
   - Whether alerts on 429 share, SIWE failure rate, and request IP concentration are actually set
NOTE

say ""
say "ok $pass · problem $fail · unknown $unknown"
say ""
say "Record this result in the deployment log with the date. Otherwise the same thing"
say "gets investigated again next time."

# Unknown is not failure. Counting what cannot be known from outside as failure would mean
# nobody uses this script as a gate.
(( fail == 0 ))
