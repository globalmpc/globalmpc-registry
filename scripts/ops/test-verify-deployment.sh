#!/usr/bin/env bash
#
# Checks verify-deployment.sh against a local stub server.
#
# The deployed web answers `/health/ready` and `/metrics` with its own 404 HTML page (those
# paths are outside the `/api/*` proxy matcher). The script used to read that page as "the
# DB is not ready" and "no worker signal", three false problems. A path the script cannot read
# is unknown, not a problem.
#
# Usage:
#   ./test-verify-deployment.sh
#
# Needs python3 and curl. Starts a stub on a free local port and stops it on exit.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
stub_pid=""

cleanup() {
  [ -n "$stub_pid" ] && kill "$stub_pid" 2>/dev/null || true
  [ -n "$stub_pid" ] && wait "$stub_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# The scenario is read from $work/scenario on every request, so one server serves all cases.
cat >"$work/stub.py" <<'PY'
import http.server, os, sys

work = sys.argv[1]
NOT_FOUND = b"<!DOCTYPE html><html><body><h1>404</h1>This page could not be found.</body></html>"
METRICS_ALL = (
    b"# TYPE mpc_worker_seconds_since_heartbeat gauge\n"
    b'mpc_worker_seconds_since_heartbeat{state="anchor"} 5\n'
    b'mpc_worker_seconds_since_heartbeat{state="scan"} 7\n'
    b'mpc_worker_seconds_since_heartbeat{state="outbox"} 3\n'
)
METRICS_NO_ANCHOR = (
    b"# TYPE mpc_worker_seconds_since_heartbeat gauge\n"
    b'mpc_worker_seconds_since_heartbeat{state="scan"} 7\n'
    b'mpc_worker_seconds_since_heartbeat{state="outbox"} 3\n'
)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, content_type="text/plain", extra=None):
        self.send_response(code)
        self.send_header("content-type", content_type)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        with open(os.path.join(work, "scenario")) as f:
            scenario = f.read().strip()
        path = self.path.split("?")[0]
        if path == "/api/v1/public/disclosures":
            return self.send(200, b'{"items":[]}', "application/json",
                             {"cache-control": "public, max-age=60"})
        if scenario == "web-404":
            return self.send(404, NOT_FOUND, "text/html")
        if scenario == "gateway-502":
            return self.send(502, b"Bad Gateway", "text/html")
        if path == "/health/ready":
            if scenario == "not-ready":
                return self.send(503, b'{"status":"not_ready"}', "application/json")
            return self.send(200, b'{"status":"ready"}', "application/json")
        if path == "/metrics":
            if scenario == "protected":
                return self.send(401, b"unauthorized")
            body = METRICS_NO_ANCHOR if scenario == "no-anchor" else METRICS_ALL
            return self.send(200, body)
        return self.send(404, NOT_FOUND, "text/html")

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(os.path.join(work, "port"), "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
PY

echo "web-404" >"$work/scenario"
python3 "$work/stub.py" "$work" &
stub_pid=$!
for _ in $(seq 1 50); do [ -s "$work/port" ] && break; sleep 0.1; done
[ -s "$work/port" ] || { echo "stub server did not start" >&2; exit 1; }
base="http://127.0.0.1:$(cat "$work/port")"

passed=0
failed=0

# run <scenario> <expected exit> <expected problem count> [grep pattern that must appear]
run() {
  local scenario="$1" want_exit="$2" want_problems="$3" pattern="${4:-}"
  echo "$scenario" >"$work/scenario"
  local out code=0
  out="$("$here/verify-deployment.sh" "$base" 2>&1)" || code=$?
  local problems
  problems="$(printf '%s\n' "$out" | grep -c '\[problem\]' || true)"
  local reason=""
  [ "$code" = "$want_exit" ] || reason="exit $code, want $want_exit"
  [ "$problems" = "$want_problems" ] || reason="${reason:+$reason; }problems $problems, want $want_problems"
  if [ -n "$pattern" ] && ! printf '%s\n' "$out" | grep -qE "$pattern"; then
    reason="${reason:+$reason; }missing /$pattern/"
  fi
  if [ -z "$reason" ]; then
    echo "pass — $scenario"
    passed=$((passed + 1))
  else
    echo "FAIL — $scenario: $reason"
    printf '%s\n' "$out" | sed 's/^/    /'
    failed=$((failed + 1))
  fi
}

# 404 HTML from the web is not the API talking — unknown, with the reason, never a problem.
run web-404   0 0 '\[unknown\] /health/ready 404 .*not exposed'
# Everything readable and alive.
run healthy   0 0 '\[ok\]      anchor worker alive'
# A real answer that says something is wrong is still a problem.
run no-anchor 1 1 'No anchor worker signal'
run not-ready 1 1 '/health/ready 503'
# A 5xx is the stack failing to answer (e.g. the proxy cannot reach a dead API) — a problem,
# not unknown.
run gateway-502 1 2 '\[problem\] /health/ready 502'
# A protected /metrics cannot be read — unknown.
run protected 0 0 '\[unknown\] Could not read /metrics \(HTTP 401\)'

echo ""
echo "passed $passed · failed $failed"
(( failed == 0 ))
