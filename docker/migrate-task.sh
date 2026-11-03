#!/bin/sh
# The CDK migration task's program (cdk/lib/migration-stack.ts): migrate → bootstrap → register
# the scan worker's token. Each step runs only if the one before it succeeded, and any failure
# exits non-zero, which stops the deploy before the service stacks roll.
#
# 1. Migrate (`packages/db`).
# 2. Bootstrap the first operator (`bootstrap-cli.ts`) — only when BOOTSTRAP_EMAIL is set. Unset is
#    the normal state of an environment that already has its operators: the step is skipped with
#    a log line. Every run with the same inputs is a no-op (docs/operations/deployment.md).
# 3. Register the scan worker's token (`service-token ensure`) for SCAN_SERVICE_TENANT_SLUG.
#    Bootstrap runs first, so on a brand-new environment the tenant it creates exists by now and
#    one deploy is enough.
#
# Secrets: SCAN_SERVICE_TOKEN and BOOTSTRAP_EMAIL (personal data) are moved into unexported shell
# variables before anything runs, so the migration never sees them; each is handed, in its
# environment and never on a command line, to the one step that needs it. Neither is ever echoed,
# and there is no `set -x`. (The container's first process keeps its initial environment, so
# /proc/1/environ still holds both while the task runs.)
#
# MIGRATE_TASK_ROOT exists for the test (apps/api/test/migrate-task.test.ts); the image is /repo.
set -eu

root="${MIGRATE_TASK_ROOT:-/repo}"

for v in DB_USER DB_PASSWORD DB_HOST DB_PORT DB_NAME DB_SSLMODE SCAN_SERVICE_TOKEN SCAN_SERVICE_TENANT_SLUG; do
  eval "test -n \"\${$v:-}\"" || { echo "migrate-task: $v is empty" >&2; exit 1; }
done

scan_token="$SCAN_SERVICE_TOKEN"
unset SCAN_SERVICE_TOKEN
bootstrap_email="${BOOTSTRAP_EMAIL:-}"
unset BOOTSTRAP_EMAIL

export DATABASE_URL="postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME?sslmode=$DB_SSLMODE"

cd "$root/packages/db"
node --import tsx src/cli.ts

cd "$root/apps/api"
if [ -n "$bootstrap_email" ]; then
  echo '{"msg":"migrate_task.bootstrap.run","note":"BOOTSTRAP_EMAIL is set; the address is not logged"}'
  BOOTSTRAP_EMAIL="$bootstrap_email" node --import tsx src/bootstrap-cli.ts
else
  echo '{"msg":"migrate_task.bootstrap.skipped","reason":"BOOTSTRAP_EMAIL is unset; existing operators are left as they are"}'
fi
bootstrap_email=""

SERVICE_TOKEN="$scan_token" exec node --import tsx src/service-token-cli.ts \
  ensure "$SCAN_SERVICE_TENANT_SLUG" scan-worker scan_service scan_result
