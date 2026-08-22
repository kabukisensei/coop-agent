#!/usr/bin/env bash
#
# check-context-budget.sh — CI gate to make COOP fixed context growth visible.
#
# Thresholds are set deliberately above the measured optimized baseline plus
# headroom. Intentional growth must be accompanied by a threshold update with
# reviewer-visible justification.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

GUARDRAILS_LIMIT_BYTES=6500
TOTAL_LIMIT_TOKENS=11000

py="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
if [ -z "$py" ]; then
  echo "WARN: python3 not found; cannot run context-budget check" >&2
  exit 0
fi

json="$(bash "$ROOT/bin/coop" context-budget --json)"

fail=0

# Guardrails
gr_bytes="$(printf '%s' "$json" | "$py" -c 'import json,sys; d=json.load(sys.stdin); print(d["categories"]["guardrails"].get("bytes",0))')"
if [ "$gr_bytes" -gt "$GUARDRAILS_LIMIT_BYTES" ]; then
  echo "DRIFT: docs/guardrails.md is $gr_bytes bytes (limit $GUARDRAILS_LIMIT_BYTES)"
  fail=1
fi

# Total fixed estimate
total="$(printf '%s' "$json" | "$py" -c 'import json,sys; d=json.load(sys.stdin); print(d.get("estimated_fixed_total_tokens",0))')"
if [ "$total" -gt "$TOTAL_LIMIT_TOKENS" ]; then
  echo "DRIFT: estimated fixed total is $total tokens (limit $TOTAL_LIMIT_TOKENS)"
  fail=1
fi

if [ "$fail" -eq 1 ]; then
  echo "FAIL: context-budget check exceeded threshold(s)"
  exit 1
fi

echo "PASS: context-budget within thresholds (guardrails ${gr_bytes}/${GUARDRAILS_LIMIT_BYTES} bytes, fixed total ${total}/${TOTAL_LIMIT_TOKENS} tokens)"
