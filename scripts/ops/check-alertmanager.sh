#!/usr/bin/env bash
#
# Alertmanager 설정 검사 — 2026-09-10 실사 A4.
#
# 이 파일들은 **공식 amtool로 통과해야 한다.** 예전 구성은 마운트된 파일에
# `${VAR:-...}`를 적어 뒀는데 Compose는 파일 내용을 치환하지 않는다. 그래서
# Alertmanager는 그 문자열을 URL로 읽고 설정 적재부터 실패했다 — 그런데 그
# 실패는 observability 프로파일이 켜져 있을 때만 드러난다.
#
# 검사는 배포와 같은 이미지로 한다. 다른 버전의 amtool은 다른 것을 통과시킨다.
#
# 사용: scripts/ops/check-alertmanager.sh

set -euo pipefail

image="${ALERTMANAGER_IMAGE:-prom/alertmanager:v0.28.0}"
here="$(cd "$(dirname "$0")/../.." && pwd)"
config_dir="$here/deploy/observability"

command -v docker >/dev/null || { echo "docker가 없다 — amtool 검사를 건너뛸 수 없다" >&2; exit 1; }

# 설정 파일을 **바인드 마운트하지 않고 stdin으로 흘려 넣는다.**
#
# CI 러너는 job 컨테이너 안에서 호스트의 docker 소켓을 쓴다. 그러면 `-v 경로:/cfg`의
# 경로는 job 컨테이너가 아니라 **호스트**에서 해석되고, 호스트에는 그 경로가 없으니
# 빈 디렉터리가 붙는다 — `amtool: path '/cfg/alertmanager.yml' does not exist`로
# 실제로 실패했다. 로컬(Docker Desktop)에서는 두 경로가 같아 드러나지 않는다.
#
# 네트워크를 끊고 돈다. 설정 검사는 밖으로 나갈 일이 없다.
# 검사 대상은 실제로 있는 설정만 고른다. 배포 환경별 구성(webhook)은 저장소에
# 따라 없을 수 있고, 없는 파일을 tar에 넘기면 검사가 그 자리에서 죽는다.
files=()
for name in alertmanager.yml alertmanager.webhook.yml; do
  [ -f "$config_dir/$name" ] && files+=("$name")
done
[ ${#files[@]} -gt 0 ] || { echo "검사할 alertmanager 설정이 없다: $config_dir" >&2; exit 1; }

targets=""
for name in "${files[@]}"; do targets="$targets /tmp/cfg/$name"; done

tar -C "$config_dir" -cf - "${files[@]}" \
  | docker run --rm -i --network none --entrypoint sh "$image" -c \
      "mkdir -p /tmp/cfg && tar -xf - -C /tmp/cfg && amtool check-config$targets"

echo "alertmanager 설정 검사 통과: ${files[*]}"
