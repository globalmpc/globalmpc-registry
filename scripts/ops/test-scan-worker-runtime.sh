#!/bin/bash
# Exercise the secret-free ClamAV service supervisor without Docker or downloads.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
parent=''
cleanup() {
  if [[ -n "$parent" ]]; then kill -TERM "$parent" 2>/dev/null || true; wait "$parent" 2>/dev/null || true; fi
  rm -r -- "$work"
}
trap cleanup EXIT
mkdir "$work/bin"
export PATH="$work/bin:$PATH" STATE="$work"
cat > "$work/bin/freshclam" <<'STUB'
#!/bin/bash
if [[ " $* " != *' --daemon '* ]]; then exit "${BOOTSTRAP_STATUS:-0}"; fi
trap 'echo stopped > "$STATE/updater-stopped"; exit 0' TERM INT
printf '%s\n' "$$" > "$STATE/updater"
while :; do sleep 0.1; done
STUB
cat > "$work/bin/clamd" <<'STUB'
#!/bin/bash
trap 'echo stopped > "$STATE/daemon-stopped"; exit 0' TERM INT
printf '%s\n' "$$" > "$STATE/daemon"
while :; do sleep 0.1; done
STUB
cat > "$work/bin/clamdscan" <<'STUB'
#!/bin/bash
[[ -f "$STATE/ready" ]]
STUB
chmod +x "$work/bin/"*
await_file() {
  for ((i=0;i<100;i++)); do [[ ! -f "$1" ]] || return 0; sleep 0.05; done
  echo "Timed out awaiting $1" >&2; return 1
}
assert_stopped() {
  await_file "$work/daemon-stopped"
  await_file "$work/updater-stopped"
  ! kill -0 "$(cat "$work/daemon")" 2>/dev/null
  ! kill -0 "$(cat "$work/updater")" 2>/dev/null
}
reset_state() {
  for marker in daemon updater daemon-stopped updater-stopped ready; do
    [[ ! -f "$work/$marker" ]] || rm -- "$work/$marker"
  done
}
# A failed first download must never launch the daemon or updater.
if BOOTSTRAP_STATUS=1 bash "$root/docker/clamav/entrypoint.sh" >"$work/log" 2>&1; then
  echo 'Bootstrap failure was accepted' >&2; exit 1
fi
[[ ! -f "$work/daemon" && ! -f "$work/updater" ]]
# Readiness is the daemon's actual PING result, independent of any application heartbeat.
bash "$root/docker/clamav/entrypoint.sh" >"$work/log" 2>&1 &
parent=$!
await_file "$work/daemon"
await_file "$work/updater"
if bash "$root/docker/clamav/healthcheck.sh"; then echo 'Unready scanner passed healthcheck' >&2; exit 1; fi
kill -0 "$parent"
touch "$work/ready"
bash "$root/docker/clamav/healthcheck.sh"
# Either child disappearing must stop its sibling and fail the entire service.
kill -TERM "$(cat "$work/updater")"
if wait "$parent"; then echo 'Updater loss was accepted' >&2; exit 1; fi
parent=''
assert_stopped
reset_state
touch "$work/ready"
bash "$root/docker/clamav/entrypoint.sh" >"$work/log" 2>&1 &
parent=$!
await_file "$work/daemon"
await_file "$work/updater"
kill -TERM "$(cat "$work/daemon")"
if wait "$parent"; then echo 'Daemon loss was accepted' >&2; exit 1; fi
parent=''
assert_stopped
reset_state
touch "$work/ready"
# Container termination reaches both scanner children and exits cleanly.
bash "$root/docker/clamav/entrypoint.sh" >"$work/log" 2>&1 &
parent=$!
await_file "$work/daemon"
await_file "$work/updater"
kill -TERM "$parent"
wait "$parent"
parent=''
assert_stopped
echo 'ClamAV supervision: bootstrap, readiness, daemon/updater failure, and termination passed'
