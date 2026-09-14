#!/usr/bin/env bash
#
# Alertmanager config check — 2026-09-10 audit A4.
#
# These files **must pass the official amtool.** The old config wrote `${VAR:-...}` in a
# mounted file, but Compose does not substitute file contents. So Alertmanager read that
# string as a URL and failed at config load — and that failure only showed when the
# observability profile was on.
#
# The check runs on the same image as the deploy. A different amtool version passes different things.
#
# Usage: scripts/ops/check-alertmanager.sh

set -euo pipefail

image="${ALERTMANAGER_IMAGE:-prom/alertmanager:v0.28.0}"
here="$(cd "$(dirname "$0")/../.." && pwd)"
config_dir="$here/deploy/observability"

command -v docker >/dev/null || { echo "docker not found — the amtool check cannot be skipped" >&2; exit 1; }

# The config files are **streamed via stdin, not bind-mounted.**
#
# CI runners use the host's docker socket from inside the job container. Then the path in
# `-v path:/cfg` resolves on the **host**, not the job container, and since the host lacks it
# an empty directory is mounted — it actually failed with `amtool: path '/cfg/alertmanager.yml' does not exist`.
# Locally (Docker Desktop) the two paths are the same, so it does not show.
#
# Runs with networking off. A config check has no reason to go out.
# Only configs that actually exist are checked. Per-environment config (webhook) may be absent
# depending on the repository, and passing a missing file to tar kills the check on the spot.
files=()
for name in alertmanager.yml alertmanager.webhook.yml; do
  [ -f "$config_dir/$name" ] && files+=("$name")
done
[ ${#files[@]} -gt 0 ] || { echo "No alertmanager config to check: $config_dir" >&2; exit 1; }

targets=""
for name in "${files[@]}"; do targets="$targets /tmp/cfg/$name"; done

tar -C "$config_dir" -cf - "${files[@]}" \
  | docker run --rm -i --network none --entrypoint sh "$image" -c \
      "mkdir -p /tmp/cfg && tar -xf - -C /tmp/cfg && amtool check-config$targets"

echo "alertmanager config check passed: ${files[*]}"
