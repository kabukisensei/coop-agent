#!/usr/bin/env bash
#
# ado-digest — thin launcher for scripts/ado-digest.py (the Azure DevOps boards
# watchdog digest; see the azure-devops skill). Locates Python and passes every
# argument straight through. Deliberately minimal and self-contained so it runs
# cleanly under cron / launchd with no TTY, color, or coop launch machinery.
#
# bash 3.2 compatible. Windows twin: scripts/ado-digest.ps1.
#
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "ado-digest: python3 (or python) not found on PATH" >&2
  exit 127
fi

exec "$PY" "$SCRIPT_DIR/ado-digest.py" "$@"
