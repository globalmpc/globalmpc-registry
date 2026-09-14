#!/bin/sh
# Download the signature DB **at least once** before starting clamd.
#
# Without a DB, clamd starts but scanning is meaningless. A pass in that state means "not
# looked at", not "clean", and if the two cannot be told apart there is no point in having a
# scanner. So startup is refused on failure — it is never left silently open.
set -eu

if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then
  echo "No signature DB. Downloading with freshclam (takes a few minutes)."
  freshclam --foreground --stdout --config-file=/etc/clamav/freshclam.conf
fi

# Later updates run in the background. `Checks 24` means 24 times a day.
freshclam --daemon --foreground=false --stdout --config-file=/etc/clamav/freshclam.conf || \
  echo "Could not start the freshclam daemon. Scanning continues with the current DB."

exec clamd --config-file=/etc/clamav/clamd.conf
