#!/usr/bin/env bash
#
# context-budget tests — verify `coop context-budget` reports sizes and obeys basic
# contracts: JSON schema, required fields, static estimates, and the optional
# --measure warning path. No network or model calls.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
COOP="$ROOT/bin/coop"

fail() { echo "  ✗ $1" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || fail "python3 required for context-budget tests"

echo "→ coop context-budget human-readable mode"
OUT="$(bash "$COOP" context-budget)"
case "$OUT" in
  *"COOP context budget"*) ;;
  *) fail "human output missing header" ;;
esac
case "$OUT" in
  *"Estimated fixed total"*) ;;
  *) fail "human output missing total" ;;
esac
case "$OUT" in
  *"docs/guardrails.md"*) ;;
  *) fail "human output missing guardrails path" ;;
esac
echo "  ✓ human-readable output looks correct"

echo "→ coop context-budget --json"
JSON="$(bash "$COOP" context-budget --json)"
PY_RC=0
python3 - "$JSON" <<'PY' || PY_RC=$?
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    print(f"  ✗ JSON parse failed: {e}", file=sys.stderr)
    sys.exit(1)
assert d.get("schema_version") == 1, "schema_version must be 1"
assert d.get("measurement", {}).get("method") == "static_char_estimate", "method must be static_char_estimate"
assert d.get("measurement", {}).get("token_formula") == "ceil(chars/4)", "token_formula must be ceil(chars/4)"
cats = d.get("categories", {})
for key in ("guardrails", "profile", "project_instructions", "skills", "native_tools", "extensions", "on_demand_inventory"):
    assert key in cats, f"missing category: {key}"
assert "prompts" in cats.get("on_demand_inventory", {}), "missing on_demand_inventory.prompts"
assert cats["guardrails"].get("bytes", 0) > 0, "guardrails bytes must be > 0"
assert cats["guardrails"].get("chars", 0) > 0, "guardrails chars must be > 0"
assert d.get("estimated_fixed_total_tokens", 0) > 0, "estimated_fixed_total_tokens must be > 0"
assert d.get("total_chars", 0) > 0, "total_chars must be > 0"
PY
[ "$PY_RC" -eq 0 ] || fail "JSON schema validation failed"
echo "  ✓ JSON output schema is valid"

echo "→ coop context-budget --measure warns and falls back to static estimate"
MEASURE_OUT="$(bash "$COOP" context-budget --measure 2>&1)"
MEASURE_RC=$?
[ "$MEASURE_RC" -eq 0 ] || fail "--measure exited $MEASURE_RC (expected 0)"
case "$MEASURE_OUT" in
  *"Static estimate"*) ;;
  *) fail "--measure output missing static estimate label" ;;
esac
echo "  ✓ --measure falls back to static estimate"

echo "→ context-budget JSON values are consistent"
python3 - "$JSON" <<'PY'
import json, sys, math
d = json.loads(sys.argv[1])
total = d["total_chars"]
assert d["estimated_fixed_total_tokens"] == math.ceil(total / 4), "token estimate must be ceil(chars/4)"
cats = d["categories"]
expected = cats["guardrails"]["chars"] + cats["profile"]["chars"] + cats["project_instructions"]["chars"] + cats["skills"]["description_chars"] + cats["native_tools"]["schema_chars"]
assert total == expected, f"total_chars mismatch: {total} != {expected}"
PY
echo "  ✓ JSON values are consistent"
