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

# --- checked-in example is documentation only; generator owns runtime specs ---
if grep -q '"mcpServers": {}' "$EXAMPLE" && ! grep -q '@latest\|TODO-' "$EXAMPLE"; then
  ok "mcp.example.json carries no duplicate runtime package authority"
else
  ko "mcp.example.json must remain an empty documentation skeleton"
fi

# --- doctor reports the configured mode ---------------------------------------
# Doctor discovers mcp.json from the cwd first (as $PWD/.mcp.json), so run each
# case from its own scratch directory.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

doctor_out() {
  ( cd "$1" && COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null )
}

# Read-only + --start → reported as GOOD (started, read-only).
d="$TMP/good"
mkdir -p "$d"
cat > "$d/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "powerbi-modeling-mcp": {
      "command": "npx",
      "args": ["-y", "@microsoft/powerbi-modeling-mcp@latest", "--start", "--readonly"]
    }
  }
}
EOF
out="$(doctor_out "$d")"
case "$out" in
  *"started, read-only"*) ok "doctor reports powerbi-modeling-mcp started+read-only as healthy" ;;
  *) ko "doctor did not report good state"; echo "$out" ;;
esac

# Missing --start → warned (server will not launch).
d="$TMP/nostart"
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
  *"missing --start"*) ok "doctor warns when powerbi-modeling-mcp lacks --start" ;;
  *) ko "doctor did not warn on missing --start"; echo "$out" ;;
esac

# Read-only mode without start (legacy shape) still reports read-only presence via the
# missing-start warning; read-write (--start only) → warned strongly.
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
  *"missing --readonly"*) ok "doctor warns strongly on powerbi-modeling-mcp missing --readonly" ;;
  *) ko "doctor did not warn on missing --readonly"; echo "$out" ;;
esac

# Unclear/no-flags → still not healthy: missing --start fires first.
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
  *"missing --start"*) ok "doctor treats a flagless powerbi-modeling-mcp as unusable" ;;
  *) ko "doctor did not warn on unusable modeling config"; echo "$out" ;;
esac

# --- exact extension-fleet verification -----------------------------------------
# Stub `pi` reporting an up-to-date fleet: every manifest extension at its pin.
stub_ok="$(mktemp -d)"
cat > "$stub_ok/pi" <<EOF
#!/bin/sh
[ "\$1" = "list" ] && {
  cat "$ROOT/config/release-manifest.json" | python3 -c '
import json,sys
m=json.load(sys.stdin)
for k,v in m["extensions"].items(): print(f"{k} {v}")'
  exit 0
}
echo "pi 0.80.2"
EOF
chmod +x "$stub_ok/pi"
out="$(PATH="$stub_ok:$PATH" COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null)"
case "$out" in
  *"matches manifest"*) ok "doctor verifies each managed extension against its manifest pin" ;;
  *) ko "doctor did not verify extension pins"; echo "$out" ;;
esac
ext_section="$(printf '%s\n' "$out" | sed -n '/Pi extensions/,/MCP servers/p')"
case "$ext_section" in
  *"not installed"*|*"differs from manifest"*|*"newer than manifest"*) ko "pinned fleet must be green in the extension section" ;;
  *) ok "a pinned fleet produces no extension warnings" ;;
esac
rm -rf "$stub_ok"

# Drifted fleet: one extension newer than the pin must be flagged.
stub_drift="$(mktemp -d)"
cat > "$stub_drift/pi" <<EOF
#!/bin/sh
[ "\$1" = "list" ] && {
  cat "$ROOT/config/release-manifest.json" | python3 -c '
import json,sys
m=json.load(sys.stdin)
first=sorted(m["extensions"])[0]
for k,v in m["extensions"].items():
    print(f"{k} 9.9.9" if k==first else f"{k} {v}")'
  exit 0
}
echo "pi 0.80.2"
EOF
chmod +x "$stub_drift/pi"
out="$(PATH="$stub_drift:$PATH" COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null)"
case "$out" in
  *"newer than manifest"*) ok "doctor flags an extension newer than its manifest pin" ;;
  *) ko "doctor missed extension drift"; echo "$out" ;;
esac
rm -rf "$stub_drift"

if [ "$fail" -ne 0 ]; then echo "  ✗ doctor-mcp-mode tests FAILED"; exit 1; fi
echo "  doctor-mcp-mode tests passed"

# --- doctor against a GENERATED mcp.json (pretty-printed, not a hand fixture) ---
# The real generator writes multi-line JSON; line-greps would only ever see
# '"args": [' and falsely report missing flags.
d="$TMP/generated"
mkdir -p "$d"
printf '%s\n' '{"schema_version":1,"azure":{"tenant_id":"tenant-1"},"integrations":{"fabric":false,"power_bi":true,"power_bi_modeling":true,"azure_devops":false,"microsoft_learn":false},"azure_devops":{"organization":"org"}}' > "$d/config"
COOP_ROOT="$ROOT" bash -c "cd '$d' && python3 '$ROOT/lib/mcp_config.py' --config '$d/config' --output '$d/.mcp.json'" || ko "generator failed on scratch config"
out="$(doctor_out "$d")"
case "$out" in
  *"powerbi-modeling-mcp configured (started, read-only)"*) ok "doctor reads generated pretty-printed MCP JSON correctly" ;;
  *) ko "doctor misreads generated MCP JSON"; echo "$out" | grep -i modeling ;;
esac
grep -q '"args": \[' "$d/.mcp.json" && ok "fixture really is pretty-printed (multi-line args)" || ok "generator emitted compact JSON"
