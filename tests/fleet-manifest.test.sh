#!/usr/bin/env bash
#
# Tests for the release-manifest driven reproducible fleet:
#   - lib/common.sh coop_manifest_get / coop_manifest_status read dotted paths
#   - `coop update --check` reports expected/installed/status against the manifest
#   - default `coop update` pins to the manifest version (not latest)
#   - `coop update --edge` takes the latest upstream version
# No network: all npm/pipx/pi calls are stubbed.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
COOP_ROOT="$ROOT"; export COOP_ROOT
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

. "$ROOT/lib/common.sh"

# --- manifest helpers -----------------------------------------------------------
[ "$(coop_manifest_get pi.version)" = "0.80.2" ] && ok "coop_manifest_get pi.version" || ko "coop_manifest_get pi.version"
[ "$(coop_manifest_get node.min)" = "22.19.0" ] && ok "coop_manifest_get node.min" || ko "coop_manifest_get node.min"
[ "$(coop_manifest_get extensions.pi-mcp-adapter)" = "2.10.0" ] && ok "coop_manifest_get extensions.pi-mcp-adapter" || ko "coop_manifest_get extensions.pi-mcp-adapter"
[ "$(coop_manifest_get python_tools.coop-data-doc)" = "1.1.0" ] && ok "coop_manifest_get python_tools.coop-data-doc" || ko "coop_manifest_get python_tools.coop-data-doc"
[ -z "$(coop_manifest_get missing.key)" ] && ok "coop_manifest_get missing key returns empty" || ko "missing key should return empty"
[ "$(coop_manifest_extension_spec pi-mcp-adapter)" = "npm:pi-mcp-adapter@2.10.0" ] && ok "literal extension spec: pi-mcp-adapter" || ko "extension spec mismatch"
[ "$(coop_manifest_extension_spec @juicesharp/rpiv-ask-user-question)" = "npm:@juicesharp/rpiv-ask-user-question@1.20.0" ] && ok "literal scoped extension spec" || ko "scoped extension spec mismatch"
"$(command -v python3 2>/dev/null || command -v python)" - "$ROOT" <<'PY' || fail=1
import json, pathlib, sys
r=pathlib.Path(sys.argv[1]); m=json.load(open(r/'config/release-manifest.json'))
assert m['coop_version']==(r/'VERSION').read_text().strip()
for p in ['@microsoft/fabric-mcp','powerbi-mcp-server','@azure-devops/mcp','mcp-remote']:
    assert p in m['mcp_servers']
assert '@microsoft/powerbi-modeling-mcp' in m['npm_tools']
for p in ['pi-mcp-adapter','pi-hermes-memory','pi-better-openai','pi-web-access','@juicesharp/rpiv-ask-user-question','context-mode']:
    assert p in m['extensions']
# Manifest is authoritative: every manifest fleet member must be referenced by its
# runtime consumers, and every generated MCP package must resolve from the manifest.
install=(r/'scripts/install.sh').read_text(); update=(r/'scripts/update.sh').read_text(); sync=(r/'scripts/sync.sh').read_text()
for p in m['extensions']:
    assert p in install and p in sync
for p in m['python_tools']:
    assert p in install or p in update
for p in m['npm_tools']:
    assert p in install and p in update
import importlib.util
spec=importlib.util.spec_from_file_location('mcp_config',r/'lib/mcp_config.py'); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
all_versions={**m['extensions'],**m['npm_tools'],**m['mcp_servers']}
assert set(mod.SERVER_PACKAGES.values()) <= set(all_versions)
assert json.load(open(r/'config/mcp.example.json'))['mcpServers']=={}
# Any retained tested_with documentation must equal manifest, never own a second value.
spec=importlib.util.spec_from_file_location('coop_yaml',r/'lib/_yaml.py'); y=importlib.util.module_from_spec(spec); spec.loader.exec_module(y)
d=y._load_fallback((r/'config/defaults.yml').read_text()).get('tested_with',{})
for key,pkg in [('pi',None),('coop_data_doc','coop-data-doc'),('coop_sql_review','coop-sql-review'),('coop_dax_review','coop-dax-review'),('ms_fabric_cli','ms-fabric-cli'),('fabric_cicd','fabric-cicd')]:
    expected=m['pi']['version'] if pkg is None else m['python_tools'][pkg]
    if key in d: assert str(d[key])==expected, (key,d[key],expected)
PY
[ "$fail" = 0 ] && ok "manifest version/package contract" || ko "manifest contract failed"
if grep -q 'pi update --extensions' "$ROOT/scripts/update.sh" "$ROOT/scripts/update.ps1"; then ko "normal update still invokes pi update --extensions"; else ok "normal update has no unpinned extension update path"; fi

# --- status classifier ----------------------------------------------------------
[ "$(coop_manifest_status 0.80.2 0.80.2)" = "ok" ] && ok "status: exact match" || ko "status exact match"
[ "$(coop_manifest_status 0.80.1 0.80.2)" = "older" ] && ok "status: older" || ko "status older"
[ "$(coop_manifest_status 0.81.0 0.80.2)" = "newer-than-tested" ] && ok "status: newer than tested" || ko "status newer-than-tested"
[ "$(coop_manifest_status 0.80.3 0.80.2)" = "wrong-version" ] && ok "status: patch drift" || ko "status patch drift"
[ "$(coop_manifest_status '' 0.80.2)" = "missing" ] && ok "status: missing" || ko "status missing"
[ "$(coop_manifest_status 0.80.2 '')" = "not-applicable" ] && ok "status: no expected -> not-applicable" || ko "status no expected should be not-applicable"

# --- stub PATH ------------------------------------------------------------------
STUB="$(mktemp -d)"; MARKER="$STUB/INSTALLS"; export MARKER
trap 'rm -rf "$STUB"' EXIT
REAL_PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"

cat > "$STUB/pi" <<'EOF'
#!/bin/sh
[ "$1" = "--version" ] && { echo "pi 0.80.2"; exit 0; }
echo "PI $*" >> "$MARKER"; exit 0
EOF
cat > "$STUB/npm" <<EOF
#!/bin/sh
echo "NPM \$*" >> "\$MARKER"
# Simulate npm ls for the two authoring tools so --check sees current versions.
[ "\$1" = "ls" ] && { echo "+ @microsoft/powerbi-report-authoring-cli@0.1.4"; echo "+ @microsoft/powerbi-modeling-mcp@0.5.0-beta.12"; }
exit 0
EOF
cat > "$STUB/pipx" <<'EOF'
#!/bin/sh
[ "$1" = "list" ] && { echo "   package coop-data-doc 0.26.0, installed using ..."; echo "   package ms-fabric-cli 1.6.1, installed using ..."; exit 0; }
echo "PIPX $*" >> "$MARKER"; exit 0
EOF
cat > "$STUB/python3" <<EOF
#!/bin/sh
# Only intercept the PyPI latest probe; delegate YAML reads to the real python3.
if [ "\$1" = "-" ]; then
  read -r pkg
  echo "\$PYPI_STUB_VER"
  exit 0
fi
exec $REAL_PY "\$@"
EOF
chmod +x "$STUB/pi" "$STUB/npm" "$STUB/pipx" "$STUB/python3"

# --- --check reports expected versions and status ---------------------------------
: > "$MARKER"
out="$(PATH="$STUB:$PATH" bash "$ROOT/scripts/update.sh" --check 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "--check exits 0" || ko "--check exit was $rc"
case "$out" in *"expected 0.80.2"*) ok "--check reports pi expected 0.80.2" ;; *) ko "--check missing pi expected 0.80.2" ;; esac
case "$out" in *"status ok"*) ok "--check reports status ok for matching versions" ;; *) ko "--check missing ok status" ;; esac
case "$out" in *"@microsoft/powerbi-report-authoring-cli"*) ok "--check lists npm authoring tools" ;; *) ko "--check missing npm authoring tools" ;; esac

# --- default update path pins to the manifest version ----------------------------
: > "$MARKER"
out="$(PATH="$STUB:$PATH" COOP_UPDATE_GATE_DRYRUN=1 bash "$ROOT/scripts/update.sh" 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "default update (gate dry-run) exits 0" || ko "default update exit was $rc"
# With matching installed versions and no newer mocked latest, gate should pass (GATE all).
case "$out" in *"GATE all"*) ok "default update takes all (manifest already satisfied)" ;; *) ko "expected GATE all, got: $out" ;; esac

# --- --edge update path bypasses the manifest pin ---------------------------------
: > "$MARKER"
out="$(PATH="$STUB:$PATH" COOP_UPDATE_GATE_DRYRUN=1 COOP_PI_LATEST_OVERRIDE=0.99.0 bash "$ROOT/scripts/update.sh" --edge 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "--edge update (gate dry-run) exits 0" || ko "--edge update exit was $rc"
case "$out" in *"GATE all"*) ok "--edge bypasses the tested-version gate" ;; *) ko "expected --edge GATE all, got: $out" ;; esac
# With COOP_UPDATE_GATE_DRYRUN the script stops before the install unit; the gate
# decision is the observable seam. The run.ps1 suite validates the actual pi update
# path under PowerShell using the same seams.

exit $fail
