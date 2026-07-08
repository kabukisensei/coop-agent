#!/usr/bin/env bash
#
# ado-onboard — thin launcher for scripts/ado-onboard.py (guided, read-only Azure
# DevOps client onboarding; see the azure-devops skill). Locates Python and passes
# every argument straight through. Minimal and self-contained.
#
# bash 3.2 compatible. Windows twin: scripts/ado-onboard.ps1.
#
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "ado-onboard: python3 (or python) not found on PATH" >&2
  exit 127
fi

exec "$PY" "$SCRIPT_DIR/ado-onboard.py" "$@"
