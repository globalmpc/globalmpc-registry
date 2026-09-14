#!/bin/sh
# clamd를 띄우기 전에 시그니처 DB를 **반드시** 한 번 받는다.
#
# DB 없이 clamd를 띄우면 기동은 되지만 검사가 성립하지 않는다. 그 상태의 통과는
# "깨끗하다"가 아니라 "보지 않았다"이며, 둘을 구분하지 못하면 스캐너를 두는 의미가
# 없다. 그래서 실패하면 기동을 거절한다 — 조용히 열린 채로 두지 않는다.
set -eu

if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then
  echo "시그니처 DB가 없다. freshclam으로 받는다 (몇 분 걸린다)."
  freshclam --foreground --stdout --config-file=/etc/clamav/freshclam.conf
fi

# 이후 갱신은 백그라운드로 돈다. `Checks 24`가 하루 24회다.
freshclam --daemon --foreground=false --stdout --config-file=/etc/clamav/freshclam.conf || \
  echo "freshclam 데몬을 띄우지 못했다. 검사는 현재 DB로 계속한다."

exec clamd --config-file=/etc/clamav/clamd.conf
