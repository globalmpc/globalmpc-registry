#!/bin/sh
# Recipe E: keep OTel opt-in and outside the application's dependency tree.
# Incomplete configuration leaves the original process entirely uninstrumented.
if [ "${OTEL_ENABLED:-}" = "true" ] && \
   [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && \
   [ -n "${OTEL_SERVICE_NAME:-}" ]; then
  otel_runtime_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  export OTEL_NODE_RESOURCE_DETECTORS=env,host,os
  export OTEL_METRICS_EXPORTER=none
  export OTEL_BSP_SCHEDULE_DELAY=1000
  export OTEL_BLRP_SCHEDULE_DELAY=1000
  export OTEL_EXPORTER_OTLP_TIMEOUT=1200
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=${otel_runtime_dir}/register.mjs"
fi
exec "$@"
