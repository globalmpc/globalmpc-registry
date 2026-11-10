#!/bin/sh
# Separate invocation after services are healthy. Never part of migration or service startup.
set -eu
if [ "${DEPLOY_ENVIRONMENT:-}" != develop ] || [ "${CHAIN_ID:-}" != 5611 ]; then
  echo 'dev demo requires develop and chain 5611' >&2
  exit 1
fi
for v in DB_USER DB_PASSWORD DB_HOST DB_PORT DB_NAME DB_SSLMODE OBJECT_BUCKET OBJECT_REGION DEMO_TENANT_SLUG; do
  eval "test -n \"\${$v:-}\"" || { echo "dev demo: $v is empty" >&2; exit 1; }
done
# Encode generated credentials instead of interpolating them into a URL as raw characters.
export DATABASE_URL
DATABASE_URL="$(node -e '
  const u = new URL("postgres://localhost");
  u.username=encodeURIComponent(process.env.DB_USER); u.password=encodeURIComponent(process.env.DB_PASSWORD);
  u.hostname=process.env.DB_HOST; u.port=process.env.DB_PORT;
  u.pathname="/"+encodeURIComponent(process.env.DB_NAME); u.searchParams.set("sslmode",process.env.DB_SSLMODE);
  process.stdout.write(u.href);
')"
unset DB_PASSWORD SCAN_SERVICE_TOKEN BOOTSTRAP_EMAIL
cd "${DEMO_TASK_ROOT:-/repo}/apps/api"
exec node --import tsx src/dev-demo-cli.ts
