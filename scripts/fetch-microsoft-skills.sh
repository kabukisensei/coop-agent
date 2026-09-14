#!/usr/bin/env bash
#
# Compatibility delegator for the managed Microsoft skills catalog.
#
# Usage: scripts/fetch-microsoft-skills.sh
#
# Prefer `coop sync`; this script remains for older docs/automation and delegates
# to the same pinned catalog refresh path. It does not copy skills into the repo.
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

py="$(coop_python 2>/dev/null || true)"
[ -n "$py" ] || coop_die "python is required to refresh Microsoft skills."

if "$py" "$COOP_ROOT/lib/microsoft_skills.py" refresh; then
  coop_ok "Microsoft skills catalog refreshed."
else
  coop_warn "Microsoft skills catalog refresh failed; last-known-good preserved if present."
fi
