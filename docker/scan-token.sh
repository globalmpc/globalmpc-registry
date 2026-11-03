#!/bin/sh
# Local stand-in for the deploy's token registration (the migration task's `service-token
# ensure`). Generates the scan worker's token once into the `scantoken` volume, then registers its
# hash for the `scan-worker` service subject of SCAN_SERVICE_TENANT_SLUG. Re-running changes
# nothing; deleting the volume rotates the token on the next run.
#
# Never prints the token. It reaches the CLI through the environment, not the command line.
set -eu

file=/run/scan-token/token
if [ ! -s "$file" ]; then
  umask 077
  node --import tsx src/service-token-cli.ts generate > "$file.tmp"
  mv "$file.tmp" "$file"
fi
# Readable by the scan worker's group (gid 10001) and nobody else.
chown 0:10001 "$file"
chmod 0440 "$file"

if [ -z "${SCAN_SERVICE_TENANT_SLUG:-}" ]; then
  echo "scan-token: SCAN_SERVICE_TENANT_SLUG is unset, so the token is not registered and the" \
    "scan worker gets 401. Bootstrap a tenant, set SCAN_SERVICE_TENANT_SLUG, then run" \
    "'docker compose run --rm scan-token'." >&2
  exit 0
fi

SERVICE_TOKEN="$(cat "$file")" exec node --import tsx src/service-token-cli.ts \
  ensure "$SCAN_SERVICE_TENANT_SLUG" scan-worker scan_service scan_result
