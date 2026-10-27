#!/bin/bash
set -eu
clamdscan --config-file=/etc/clamav/clamd.conf --ping 1 >/dev/null 2>&1
