#!/usr/bin/env bash
# Collect a sanitized Support Center bundle: component health, versions, and
# recent events; preview in the terminal; export under the support dir with
# bounded retention. Pure Node + shell — runs when the Pi/model runtime is
# unavailable. Usage: coop support [--json] [--export PATH] [--incident]
set -euo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT

exec node "$COOP_ROOT/lib/support-center-cli.mjs" "$@"
