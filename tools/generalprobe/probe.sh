#!/usr/bin/env bash
set -euo pipefail
# No shell tracing: arguments/environment may contain operator secrets.
set +x
exec python3 "$(dirname "$0")/generalprobe.py" probe "$@"
