#!/usr/bin/env bash
#
# Tests for doctor's Power BI Modeling MCP mode reporting and the example config.
# Verifies that the shipped example config defaults to read-only and that doctor
# reports read-only / warns on read-write / warns on unclear mode.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
COOP_ROOT="$ROOT"; export COOP_ROOT
# Doctor's Azure sign-in row probes az; only the H2 cases below opt back in, with a fake.
COOP_SKIP_AZ=1; export COOP_SKIP_AZ
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

# Warehouse token-acquisition states must produce specific guidance. Stub only
# warehouse_mcp.py; all other Python calls delegate to the real interpreter.
state_stub="$TMP/warehouse-state-bin"
mkdir -p "$state_stub"
COOP_TEST_REAL_PY="$(command -v python3)"; export COOP_TEST_REAL_PY
cat > "$state_stub/python3" <<'EOF'
#!/bin/sh
case "${1:-}" in
  *warehouse_mcp.py)
    printf '{"state":"%s","target":{"scope":"global"},"tenant":"%s"}\n' "$COOP_WAREHOUSE_TEST_STATE" "${COOP_WAREHOUSE_TEST_TENANT:-}"
    exit 0
    ;;
esac
exec "$COOP_TEST_REAL_PY" "$@"
EOF
chmod +x "$state_stub/python3"
d="$TMP/warehouse-states"
mkdir -p "$d"
cat > "$d/.mcp.json" <<'EOF'
{"mcpServers":{"fabric-sqlendpoint":{"command":"npx","args":["-y","mcp-remote@0.1.38","https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint","--transport","http-only","--silent"]}}}
EOF
while IFS='|' read -r state hint; do
  out="$(COOP_WAREHOUSE_TEST_STATE="$state" PATH="$state_stub:$PATH" doctor_out "$d")"
  case "$out" in
    *"fabric-sqlendpoint $state (global target)"*"$hint"*) ok "doctor maps Warehouse $state to accurate guidance" ;;
    *) ko "doctor misreported Warehouse $state"; printf '%s\n' "$out" ;;
  esac
done <<'EOF'
azure_cli_unavailable|install/repair Azure CLI and ensure az is on PATH; this is not an authentication diagnosis
token_timeout|Azure CLI token command exceeded the bounded timeout; retry after checking Azure CLI responsiveness
token_command_failed|Azure CLI launched but token acquisition failed; run: az account get-access-token --resource https://api.fabric.microsoft.com --output json
token_output_invalid|Azure CLI returned no usable accessToken JSON; verify the Fabric token command output
auth_required|sign in with Azure CLI/tenant access; doctor never triggers login
EOF
# H2b: the Warehouse row names the tenant its probe minted for, and its token
# command hint pins that tenant. The fabric row states that coop cannot pin the
# tenant of @microsoft/fabric-mcp (it uses az's default account).
cat > "$d/.mcp.json" <<'EOF'
{"mcpServers":{"fabric":{"command":"npx","args":["-y","@microsoft/fabric-mcp"]},"fabric-sqlendpoint":{"command":"npx","args":["-y","mcp-remote@0.1.38","https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint","--transport","http-only","--silent"]}}}
EOF
h2b_tenant='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
out="$(COOP_WAREHOUSE_TEST_STATE=registered COOP_WAREHOUSE_TEST_TENANT="$h2b_tenant" PATH="$state_stub:$PATH" doctor_out "$d")"
case "$out" in
  *"fabric-sqlendpoint registered (global target, tenant $h2b_tenant; direct HTTP"*) ok "doctor names the tenant the Warehouse probe minted for" ;;
  *) ko "doctor did not name the Warehouse probe tenant"; printf '%s\n' "$out" | grep -i fabric ;;
esac
case "$out" in
  *"fabric server configured (uses az's default account; coop cannot pin its tenant)"*) ok "doctor states that the fabric MCP tenant cannot be pinned" ;;
  *) ko "doctor did not state the fabric MCP tenant limit"; printf '%s\n' "$out" | grep -i fabric ;;
esac
out="$(COOP_WAREHOUSE_TEST_STATE=token_command_failed COOP_WAREHOUSE_TEST_TENANT="$h2b_tenant" PATH="$state_stub:$PATH" doctor_out "$d")"
case "$out" in
  *"token_command_failed (global target, tenant $h2b_tenant)"*"--output json --tenant $h2b_tenant"*) ok "doctor's Warehouse token hint names the client tenant" ;;
  *) ko "doctor's Warehouse token hint lost the tenant"; printf '%s\n' "$out" | grep -i fabric ;;
esac

# Azure sign-in row (H2): probe only, never a sign-in, same tenant chain as the
# launch. Sandboxed HOME/COOP_DIR, the shared fake az, no python3 stub.
az_bin="$TMP/az-bin"; az_state="$TMP/az-state"; az_home="$TMP/az-home"; az_cwd="$TMP/az-cwd"
mkdir -p "$az_bin" "$az_state" "$az_home/.coop" "$az_cwd"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$(command -v node)" "$ROOT/tests/fixtures/fake-az.mjs" > "$az_bin/az"
chmod +x "$az_bin/az"
az_doctor() {
  ( cd "$az_cwd" && HOME="$az_home" COOP_DIR="$az_home" USERPROFILE="$az_home" COOP_SKIP_AZ=0 \
      COOP_TEST_STUB_PATH="$az_bin" COOP_TEST_AZ_STATE="$az_state" PATH="$az_bin:$PATH" \
      bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null )
}
out="$(az_doctor)"
case "$out" in
  *"Azure sign-in: no client tenant configured"*"run: coop onboard --config-only"*) ok "doctor warns when no client tenant is configured" ;;
  *) ko "doctor did not report the missing client tenant"; printf '%s\n' "$out" | grep -i azure ;;
esac
printf '%s' '{"schema_version":1,"azure":{"purpose":"client_resources","tenant_id":"tenant-9.example"}}' > "$az_home/.coop/config"
: > "$az_state/argv.log"
out="$(az_doctor)"
case "$out" in
  *"Azure sign-in: not signed in to tenant tenant-9.example"*"az login --tenant tenant-9.example --allow-no-subscriptions"*) ok "doctor reports a signed-out client tenant with the exact sign-in command" ;;
  *) ko "doctor did not report the signed-out tenant"; printf '%s\n' "$out" | grep -i azure ;;
esac
if grep -q '^login' "$az_state/argv.log"; then ko "doctor must never sign in"
elif ! grep -q '^account get-access-token --tenant tenant-9.example ' "$az_state/argv.log"; then ko "doctor did not probe the client tenant"
else ok "doctor only probes (no az login)"; fi
printf '%s\n' 'tenant-9.example *' > "$az_state/tokens"
out="$(az_doctor)"
case "$out" in
  *"Azure sign-in: signed in to tenant tenant-9.example"*) ok "doctor reports a signed-in client tenant" ;;
  *) ko "doctor did not report the signed-in tenant"; printf '%s\n' "$out" | grep -i azure ;;
esac
[ ! -e "$az_home/.coop/agent/.az-ok" ] && ok "doctor never writes the launch cache (.az-ok)" || ko "doctor wrote the launch cache"

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

# #93: powerbi-mcp-server ignores --readonly and exposes refresh_dataset. coop no
# longer generates it and leaves a user-owned entry alone, so doctor warns with
# the reason and never reports the entry as a configured server.
d="$TMP/powerbi-mcp-server"
mkdir -p "$d"
cat > "$d/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "powerbi": {
      "command": "npx",
      "args": ["-y", "powerbi-mcp-server@0.1.0", "--authentication", "azcli", "--tenant", "user-tenant", "--readonly"]
    }
  }
}
EOF
json_out="$( cd "$d" && COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" --json 2>/dev/null </dev/null )"
if printf '%s' "$json_out" | python3 -c '
import json, sys
rows = json.load(sys.stdin)["checks"]
reason = "powerbi-mcp-server is not read-only: it ignores --readonly and exposes refresh_dataset, a write (coop-agent#93)"
hits = [r for r in rows if reason in r["name"]]
assert len(hits) == 1 and hits[0]["status"] == "warn", hits
assert hits[0]["hint"].startswith("remove that entry from "), hits
assert not any("powerbi server configured" in r["name"] for r in rows), rows
'; then
  ok "doctor warns on a user-owned powerbi-mcp-server entry and names the reason"
else
  ko "doctor did not warn on a user-owned powerbi-mcp-server entry"; printf '%s\n' "$json_out" | grep -i powerbi
fi

# --- exact extension-fleet verification -----------------------------------------
# Stub `pi` reporting an up-to-date fleet: every manifest extension at its pin.
stub_ok="$(mktemp -d)"
cat > "$stub_ok/pi" <<EOF
#!/bin/sh
[ "\$1" = "list" ] && {
  cat "$ROOT/config/release-manifest.json" | python3 -c '
import json,sys
m=json.load(sys.stdin)
for k,v in m["extensions"].items(): print(f"  npm:{k}@{v}")'
  exit 0
}
echo "pi 0.84.3"
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
drift = "9.9.9"
for k,v in m["extensions"].items():
    print(f"  npm:{k}@{drift if k==first else v}")'
  exit 0
}
echo "pi 0.84.3"
EOF
chmod +x "$stub_drift/pi"
out="$(PATH="$stub_drift:$PATH" COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null)"
case "$out" in
  *"newer than manifest"*) ok "doctor flags an extension newer than its manifest pin" ;;
  *) ko "doctor missed extension drift"; echo "$out" ;;
esac
rm -rf "$stub_drift"

# Real `pi list` output (spec line + indented install path) and a duplicate spec
# for the same extension. Only real package specs may count: the install path
# also contains the extension name, which used to read as a second version and
# turned an installed pin into a false "differs from manifest".
stub_real="$(mktemp -d)"
cat > "$stub_real/pi" <<EOF
#!/bin/sh
[ "\$1" = "list" ] && {
  cat "$ROOT/config/release-manifest.json" | python3 -c '
import json,sys
m=json.load(sys.stdin)
for k,v in m["extensions"].items():
    shown = "9.9.9" if k == "pi-mcp-adapter" else v
    print(f"  npm:{k}@{shown}")
    print(f"    HOME/.coop/agent/npm/node_modules/{k}")'
  exit 0
}
echo "pi 0.84.3"
EOF
chmod +x "$stub_real/pi"
out="$(PATH="$stub_real:$PATH" COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null)"
real_section="$(printf '%s\n' "$out" | sed -n '/Pi extensions/,/MCP servers/p')"
case "$real_section" in
  *"pi-mcp-adapter 9.9.9 is newer than manifest"*|*"pi-mcp-adapter 9.9.9: differs from manifest"*) ok "doctor reads the spec line, not the install path, for the installed version" ;;
  *"installed but version unknown"*) ko "doctor ignored the spec line and lost the installed version"; printf '%s\n' "$real_section" ;;
  *) ko "doctor misread the installed extension version"; printf '%s\n' "$real_section" ;;
esac
# A same-version duplicate (pi listing a package under two sources) must stay a
# single proof, never an ambiguity warning.
stub_dup="$(mktemp -d)"
cat > "$stub_dup/pi" <<EOF
#!/bin/sh
[ "\$1" = "list" ] && {
  cat "$ROOT/config/release-manifest.json" | python3 -c '
import json,sys
m=json.load(sys.stdin)
for k,v in m["extensions"].items():
    print(f"  npm:{k}@{v}")
    print(f"  npm:{k}@{v}")
    print(f"    HOME/.coop/agent/npm/node_modules/{k}")'
  exit 0
}
echo "pi 0.84.3"
EOF
chmod +x "$stub_dup/pi"
out="$(PATH="$stub_dup:$PATH" COOP_ROOT="$ROOT" bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null)"
dup_section="$(printf '%s\n' "$out" | sed -n '/Pi extensions/,/MCP servers/p')"
pin_mcp="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["extensions"]["pi-mcp-adapter"])' < "$ROOT/config/release-manifest.json")"
case "$dup_section" in
  *"several versions"*) ko "a same-version duplicate was reported as ambiguous" ;;
  *"pi-mcp-adapter $pin_mcp matches manifest"*) ok "a same-version duplicate still proves the pin" ;;
  *) ko "duplicate spec line broke the pin proof"; printf '%s\n' "$dup_section" ;;
esac
rm -rf "$stub_real" "$stub_dup"

parser_fixture='  npm:pi-mcp-adapter@2.10.0
    HOME/.coop/agent/npm/node_modules/pi-mcp-adapter
  npm:pi-mcp-adapter@2.10.0-beta.1
  npm:pi-mcp-adapter-tools@9.9.9'
parser_versions="$(COOP_ROOT="$ROOT" bash -c '. "$1/lib/common.sh"; coop_pi_extension_versions "$2" pi-mcp-adapter' _ "$ROOT" "$parser_fixture")"
case "$parser_versions" in
  $'2.10.0\n2.10.0-beta.1'|$'2.10.0-beta.1\n2.10.0') ok "bash parser preserves pre-release conflicts and ignores paths/name prefixes" ;;
  *) ko "bash parser returned unexpected versions: [$parser_versions]" ;;
esac
for package in pi-mcp-adapter @scope/extension; do
  case_versions="$(COOP_ROOT="$ROOT" bash -c '. "$1/lib/common.sh"; coop_pi_extension_versions "$2" "$3"' _ "$ROOT" "npm:${package}@2.10.0-beta.A
npm:${package}@2.10.0-beta.a" "$package")"
  [ "$(printf '%s\n' "$case_versions" | wc -l | tr -d ' ')" = 2 ] && ok "bash preserves case-distinct prereleases: $package" || ko "bash collapsed case-distinct prereleases: $package"
  build_versions="$(COOP_ROOT="$ROOT" bash -c '. "$1/lib/common.sh"; coop_pi_extension_versions "$2" "$3"' _ "$ROOT" "npm:${package}@2.10.0+BUILD
npm:${package}@2.10.0+build" "$package")"
  [ "$(printf '%s\n' "$build_versions" | wc -l | tr -d ' ')" = 2 ] && ok "bash preserves case-distinct builds: $package" || ko "bash collapsed case-distinct builds: $package"
  for suffix in '2.10.0/path' '2.10.0@9.9.9' '2.10.0-..' '2.10.0+..' '02.10.0'; do
    malformed="npm:${package}@${suffix}"
    parsed="$(COOP_ROOT="$ROOT" bash -c '. "$1/lib/common.sh"; coop_pi_extension_versions "$2" "$3"' _ "$ROOT" "$malformed" "$package")"
    if [ -z "$parsed" ]; then ok "bash parser rejects malformed package spec: $malformed"; else ko "bash parser accepted malformed package spec: $malformed"; fi
  done
  terminated_versions="$(COOP_ROOT="$ROOT" bash -c '. "$1/lib/common.sh"; coop_pi_extension_versions "$2" "$3"' _ "$ROOT" "npm:${package}@2.10.0  " "$package")"
  [ "$terminated_versions" = '2.10.0' ] && ok "bash normalizes trailing whitespace: $package" || ko "bash rejected a whitespace-terminated spec: $package"
  terminated_versions="$(COOP_ROOT="$ROOT" bash -c '. "$1/lib/common.sh"; coop_pi_extension_versions "$2" "$3"' _ "$ROOT" "$(printf 'npm:%s@2.10.0\r\n' "$package")" "$package")"
  [ "$terminated_versions" = '2.10.0' ] && ok "bash normalizes CRLF: $package" || ko "bash rejected a CRLF-terminated spec: $package"
done

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
