#!/bin/bash
# Exercise supervision without signatures, network downloads, or a running Docker daemon.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
parent=''
cleanup() {
  if [[ -n "$parent" ]]; then kill -TERM "$parent" 2>/dev/null || true; wait "$parent" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir "$work/bin"
export PATH="$work/bin:$PATH" STATE="$work"
cat > "$work/bin/freshclam" <<'STUB'
#!/bin/bash
if [[ " $* " != *' --daemon '* ]]; then exit "${BOOTSTRAP_STATUS:-0}"; fi
trap 'exit 0' TERM INT
printf '%s\n' "$$" > "$STATE/updater"
while :; do sleep 0.1; done
STUB
cat > "$work/bin/clamd" <<'STUB'
#!/bin/bash
trap 'exit 0' TERM INT
printf '%s\n' "$$" > "$STATE/daemon"
while :; do sleep 0.1; done
STUB
cat > "$work/bin/clamdscan" <<'STUB'
#!/bin/bash
[[ -f "$STATE/ready" ]]
STUB
cat > "$work/bin/worker" <<'STUB'
#!/bin/bash
trap 'echo stopped > "$STATE/stopped"; exit 0' TERM INT
printf '%s\n' "$$" > "$STATE/worker"
while :; do sleep 0.1; done
STUB
chmod +x "$work/bin/"*
await_file() {
  for ((i=0;i<100;i++)); do [[ ! -f "$1" ]] || return 0; sleep 0.05; done
  echo "Timed out awaiting $1" >&2; return 1
}
# Failed first-download must never launch application code.
if BOOTSTRAP_STATUS=1 bash "$root/docker/scan-worker/entrypoint.sh" worker >"$work/log" 2>&1; then
  echo 'Bootstrap failure was accepted' >&2; exit 1
fi
[[ ! -f "$work/worker" ]]
# Worker must remain stopped while the daemon cannot answer PING.
bash "$root/docker/scan-worker/entrypoint.sh" worker >"$work/log" 2>&1 &
parent=$!
await_file "$work/daemon"
[[ ! -f "$work/worker" ]]
touch "$work/ready"
await_file "$work/worker"
# Loss of the updater must fail the whole runtime and terminate its siblings.
kill -TERM "$(cat "$work/updater")"
if wait "$parent"; then echo 'Child loss was accepted' >&2; exit 1; fi
parent=''
await_file "$work/stopped"
! kill -0 "$(cat "$work/daemon")" 2>/dev/null
rm "$work/worker" "$work/stopped"
# Container termination must reach worker and antivirus children.
bash "$root/docker/scan-worker/entrypoint.sh" worker >"$work/log" 2>&1 &
parent=$!
await_file "$work/worker"
kill -TERM "$parent"
wait "$parent"
parent=''
await_file "$work/stopped"
! kill -0 "$(cat "$work/daemon")" 2>/dev/null
! kill -0 "$(cat "$work/updater")" 2>/dev/null
echo 'scan-worker supervision: bootstrap, readiness, child failure, and termination passed'
