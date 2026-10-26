#!/bin/bash
set -eu
# A heartbeat alone cannot establish that the antivirus child is still available.
clamdscan --config-file=/etc/clamav/clamd.conf --ping 1 >/dev/null 2>&1
node -e "const fs = require('node:fs'); try { process.exit(Date.now() - fs.statSync('/tmp/worker-heartbeat').mtimeMs < 90000 ? 0 : 1); } catch { process.exit(1); }"
