#!/usr/bin/env bash
# The entry points must fail with ONE clear, actionable message when a file
# they depend on is missing — e.g. quarantined by antivirus on a fresh Windows
# clone — instead of cascading dozens of "not recognized" errors from every
# helper call (real new-user incident, v0.23.4 era). Since master plan S1 the
# product is bin/coop.ps1 + lib/common.ps1; bin/coop is a thin Git Bash
# forwarder, so it guards a missing bin/coop.ps1 the same way.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

# --- bin/coop (forwarder): a missing bin/coop.ps1 is one clear error ----------
mkdir -p "$TMP/fwd/bin" "$TMP/fwd/lib" "$TMP/fwd/scripts"
cp "$ROOT/bin/coop" "$TMP/fwd/bin/coop"
rc=0; out="$(bash "$TMP/fwd/bin/coop" version 2>&1)" || rc=$?
[ "$rc" -ne 0 ] && ok "bin/coop exits non-zero when bin/coop.ps1 is missing (rc $rc)" \
  || ko "bin/coop exited 0 without bin/coop.ps1: $out"
case "$out" in
  *"coop.ps1 is missing"*"reinstall coop"*) ok "bin/coop names the missing coop.ps1 and the fix" ;;
  *) ko "bin/coop did not print a clear missing-coop.ps1 message: $out" ;;
esac
[ "$(printf '%s\n' "$out" | grep -c '')" -le 2 ] && ok "bin/coop prints one message, not a cascade" \
  || ko "bin/coop cascaded $(printf '%s\n' "$out" | grep -c '') lines: $out"

# --- bin/coop.ps1: a missing lib/common.ps1 is one clear error ----------------
grep -q "lib/common.ps1" "$ROOT/bin/coop.ps1" \
  && grep -q "Test-Path -LiteralPath \$CoopCommonPs1" "$ROOT/bin/coop.ps1" \
  && ok "bin/coop.ps1 guards the missing lib/common.ps1 case" \
  || ko "bin/coop.ps1 must guard the missing lib/common.ps1 case"

PWSH="$(command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null || true)"
if [ -n "$PWSH" ]; then
  mkdir -p "$TMP/ps/bin" "$TMP/ps/lib"
  cp "$ROOT/bin/coop.ps1" "$TMP/ps/bin/coop.ps1"
  ps1="$TMP/ps/bin/coop.ps1"
  if command -v cygpath >/dev/null 2>&1; then ps1="$(cygpath -w "$ps1")"; fi
  rc=0; out="$("$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$ps1" version 2>&1)" || rc=$?
  [ "$rc" -ne 0 ] && ok "bin/coop.ps1 exits non-zero when lib/common.ps1 is missing (rc $rc)" \
    || ko "bin/coop.ps1 exited 0 without lib/common.ps1: $out"
  case "$out" in
    *"coop: missing"*"common.ps1"*"git restore lib/common.ps1"*) ok "bin/coop.ps1 names the missing helper library and the fix" ;;
    *) ko "bin/coop.ps1 did not print a clear missing-common.ps1 message: $out" ;;
  esac
  case "$out" in
    *CommandNotFoundException*|*"is not recognized"*) ko "bin/coop.ps1 cascaded helper errors: $out" ;;
    *) ok "bin/coop.ps1 prints one message, not a cascade" ;;
  esac
else
  echo "  - (pwsh not on PATH: the bin/coop.ps1 behavioral check was skipped; its guard was verified by source)"
fi

if [ "$fail" -ne 0 ]; then echo "  ✗ missing-helper guard tests FAILED"; exit 1; fi
echo "✓ both entrypoints guard the missing-file case with a clear error"
