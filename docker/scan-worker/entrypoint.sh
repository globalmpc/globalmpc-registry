#!/bin/bash
# Keep all children supervised: an antivirus outage must stop this worker, never bypass scanning.
set -eu
children=()
cleanup() {
  trap '' TERM INT
  if ((${#children[@]})); then
    kill -TERM "${children[@]}" 2>/dev/null || true
    wait "${children[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT

# Always validate/update the database before starting. A failed update is allowed only when
# an existing database is present; clamd must still load that database and answer PING.
freshclam --foreground --stdout --config-file=/etc/clamav/freshclam.conf &
bootstrap=$!
children+=("$bootstrap")
if ! wait "$bootstrap"; then
  if ! compgen -G '/var/lib/clamav/main.c[vl]d' >/dev/null ||
     ! compgen -G '/var/lib/clamav/daily.c[vl]d' >/dev/null; then
    echo 'Signature bootstrap failed; refusing to start the scan worker.' >&2
    exit 1
  fi
  echo 'Signature update failed; loading the existing database.' >&2
fi
children=()
clamd --config-file=/etc/clamav/clamd.conf &
clamd_pid=$!
children+=("$clamd_pid")
freshclam --daemon --foreground --stdout --config-file=/etc/clamav/freshclam.conf &
updater_pid=$!
children+=("$updater_pid")

ready=false
for ((attempt=0; attempt<300; attempt++)); do
  kill -0 "$clamd_pid" "$updater_pid" 2>/dev/null || exit 1
  if clamdscan --config-file=/etc/clamav/clamd.conf --ping 1 >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1 &
  children+=("$!")
  wait "${children[-1]}"
  unset 'children[-1]'
done
if [[ "$ready" != true ]]; then
  echo 'ClamAV readiness timed out; refusing to start the scan worker.' >&2
  exit 1
fi
"$@" &
children+=("$!")
# Even a clean child exit means the container no longer provides its complete service.
wait -n "${children[@]}" || true
exit 1
