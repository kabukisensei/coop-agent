#!/usr/bin/env bash
#
# Compatibility delegator for the managed Microsoft skills catalog.
#
# Usage: scripts/fetch-microsoft-skills.sh
#
# Prefer `coop sync`; this script remains for older docs/automation and delegates
# to the same pinned catalog refresh path. It does not copy skills into the repo.
# Self-contained dev tooling (master plan S1: no bash product library).
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT

py="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
[ -n "$py" ] || { printf '✗ python is required to refresh Microsoft skills.\n' >&2; exit 1; }

if "$py" "$COOP_ROOT/lib/microsoft_skills.py" refresh; then
  printf '✓ Microsoft skills catalog refreshed.\n' >&2
else
  printf '! Microsoft skills catalog refresh failed; last-known-good preserved if present.\n' >&2
fi
