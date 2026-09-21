#!/usr/bin/env bash
# bin/coop and bin/coop.ps1 must fail with a clear, actionable message when the
# dot-sourced helper library (lib/common.{sh,ps1}) is missing — e.g. quarantined
# by antivirus on a fresh Windows clone — instead of cascading dozens of
# "not recognized" errors from every helper call (real new-user incident,
# v0.23.4 era).
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

grep -q 'lib/common.sh' "$ROOT/bin/coop" \
  && grep -q 'if \[ ! -f "\$COOP_ROOT/lib/common.sh" \]' "$ROOT/bin/coop" \
  || { echo "FAIL: bin/coop must guard the missing lib/common.sh case"; exit 1; }

grep -q "lib/common.ps1" "$ROOT/bin/coop.ps1" \
  && grep -q "Test-Path -LiteralPath \$CoopCommonPs1" "$ROOT/bin/coop.ps1" \
  || { echo "FAIL: bin/coop.ps1 must guard the missing lib/common.ps1 case"; exit 1; }

echo "✓ both entrypoints guard the missing-helper case with a clear error"
