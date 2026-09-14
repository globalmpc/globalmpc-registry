# ClamAV — multi-arch image including arm64
#
# The official `clamav/clamav` is **amd64 only** (checked 2026-08-28: latest, stable, 1.4, 1.5
# are all linux/amd64 only). On Apple Silicon it ran emulated with `platform: linux/amd64`,
# which made scans slow and raised the cost of checking the scan path locally — and once it
# goes unchecked, it cannot be told apart from a deployment with `scan` off.
#
# Alpine's `clamav` package builds for aarch64. So instead of the official image, it is
# built here. **Local and deployment use the same image** — if only local used a different
# scanner, "it passes locally" would end up standing in for the scan result.
#
#   docker build -t mpc-clamav deploy/clamav
#
# The signature DB is not baked into the image. Baking it in freezes the DB at image build
# date, and a scanner running on a stale DB makes a pass look like a guarantee. It downloads at
# startup — meanwhile uploads stay `quarantined`, and showing that on screen is by design.
FROM alpine:3.22

RUN apk add --no-cache clamav clamav-libunrar tini \
 && mkdir -p /run/clamav /var/lib/clamav \
 && chown -R clamav:clamav /run/clamav /var/lib/clamav

# clamd opens only a Unix socket by default. The worker connects over TCP.
# `LogFile /dev/stdout` is not used — clamav follows that symlink and refuses to start with
# "Symbolic link loop". In foreground mode logs already go to stdout, so no file is
# needed.
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

# Without tini, children of freshclam and clamd are left as zombies.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
