#!/usr/bin/env bash
#
# Tests for doctor's Power BI Modeling MCP mode reporting and the example config.
# Verifies that the shipped example config defaults to read-only and that doctor
# reports read-only / warns on read-write / warns on unclear mode.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
COOP_ROOT="$ROOT"; export COOP_ROOT
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

EXAMPLE="$ROOT/config/mcp.example.json"

# --- example config defaults to read-only -------------------------------------
case "$(cat "$EXAMPLE")" in
  *'"--readonly"'*'powerbi-modeling-mcp'*|*'powerbi-modeling-mcp'*'"--readonly"'*)
    ok "config/mcp.example.json configures powerbi-modeling-mcp with --readonly" ;;
  *) ko "config/mcp.example.json missing --readonly for powerbi-modeling-mcp" ;;
esac

# --- doctor reports the configured mode ---------------------------------------
# Doctor discovers mcp.json from the cwd first (as $PWD/.mcp.json), so run each
# case from its own scratch directory.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

doctor_out() {
  ( cd "$1" && COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null )
}

# Read-only mode → reported as OK.
d="$TMP/readonly"
mkdir -p "$d"
cat > "$d/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "powerbi-modeling-mcp": {
      "command": "npx",
      "args": ["-y", "@microsoft/powerbi-modeling-mcp@latest", "--readonly"]
    }
  }
}
EOF
out="$(doctor_out "$d")"
case "$out" in
  *"read-only mode"*) ok "doctor reports powerbi-modeling-mcp read-only mode" ;;
  *) ko "doctor did not report read-only mode"; echo "$out" ;;
esac

# Read-write mode → warned.
d="$TMP/readwrite"
mkdir -p "$d"
cat > "$d/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "powerbi-modeling-mcp": {
      "command": "npx",
      "args": ["-y", "@microsoft/powerbi-modeling-mcp@latest", "--start"]
    }
  }
}
EOF
out="$(doctor_out "$d")"
case "$out" in
  *"read-write mode"*) ok "doctor warns on powerbi-modeling-mcp read-write mode" ;;
  *) ko "doctor did not warn on read-write mode"; echo "$out" ;;
esac

# Unclear mode → warned.
d="$TMP/unclear"
mkdir -p "$d"
cat > "$d/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "powerbi-modeling-mcp": {
      "command": "npx",
      "args": ["-y", "@microsoft/powerbi-modeling-mcp@latest"]
    }
  }
}
EOF
out="$(doctor_out "$d")"
case "$out" in
  *"mode unclear"*) ok "doctor warns on powerbi-modeling-mcp unclear mode" ;;
  *) ko "doctor did not warn on unclear mode"; echo "$out" ;;
esac

if [ "$fail" -ne 0 ]; then echo "  ✗ doctor-mcp-mode tests FAILED"; exit 1; fi
echo "  doctor-mcp-mode tests passed"
