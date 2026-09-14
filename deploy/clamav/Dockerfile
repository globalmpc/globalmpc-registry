# ClamAV — arm64를 포함한 멀티아키 이미지
#
# 공식 `clamav/clamav`는 **amd64 전용**이다(2026-08-28 확인: latest·stable·1.4·1.5
# 전부 linux/amd64 하나). Apple Silicon에서는 `platform: linux/amd64`로 에뮬레이션
# 하며 돌았고, 그 상태에서는 검사가 느려 로컬에서 스캔 경로를 확인하는 비용이
# 커진다 — 확인하지 않게 되면 `scan`이 꺼진 배포와 구분되지 않는다.
#
# Alpine의 `clamav` 패키지는 aarch64를 빌드한다. 그래서 공식 이미지를 쓰는 대신
# 여기서 만든다. **로컬과 배포가 같은 이미지를 쓴다** — 로컬만 다른 스캐너를
# 쓰면 "로컬에서는 통과한다"가 검사 결과에 대해 성립하게 된다.
#
#   docker build -t mpc-clamav deploy/clamav
#
# 시그니처 DB는 이미지에 넣지 않는다. 넣으면 이미지가 만들어진 날의 DB로 고정되고,
# 낡은 DB로 도는 스캐너는 통과를 보장으로 오해하게 만든다. 기동할 때 받는다 —
# 그동안 업로드는 `quarantined`에 머물며, 그 사실이 화면에 보이는 것이 설계다.
FROM alpine:3.22

RUN apk add --no-cache clamav clamav-libunrar tini \
 && mkdir -p /run/clamav /var/lib/clamav \
 && chown -R clamav:clamav /run/clamav /var/lib/clamav

# clamd는 기본으로 유닉스 소켓만 연다. worker는 TCP로 붙는다.
# `LogFile /dev/stdout`을 쓰지 않는다 — clamav가 그 심볼릭 링크를 따라가다
# "Symbolic link loop"로 기동을 거절한다. foreground에서는 로그가 이미 stdout으로
# 나가므로 파일 지정이 필요 없다.
RUN printf '%s\n' \
      'LogTime yes' \
      'DatabaseDirectory /var/lib/clamav' \
      'TCPSocket 3310' \
      'TCPAddr 0.0.0.0' \
      'Foreground yes' \
      'User clamav' \
      'MaxFileSize 2000M' \
      'MaxScanSize 2000M' \
      'StreamMaxLength 2000M' \
    > /etc/clamav/clamd.conf \
 && printf '%s\n' \
      'DatabaseDirectory /var/lib/clamav' \
      'LogTime yes' \
      'DatabaseMirror database.clamav.net' \
      'Checks 24' \
      'Foreground yes' \
    > /etc/clamav/freshclam.conf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3310

# tini가 없으면 freshclam·clamd의 자식이 좀비로 남는다.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
