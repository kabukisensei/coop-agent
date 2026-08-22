#!/usr/bin/env bash
#
# Tests for scripts/onboard.py (coop onboard / coop profile).
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
[ -z "$PY" ] && { echo "python3 required"; exit 1; }

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

COOP_DIR="$(mktemp -d)"
trap 'rm -rf "$COOP_DIR"' EXIT
export COOP_DIR

run_onboard() {
  HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" "$@"
}

# --- first-run onboarding ---------------------------------------------------------
out="$(printf 'Test User\n1\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
preset="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["communication"]["preset"])')"
[ "$name" = "Test User" ] && ok "onboard captures name" || ko "onboard name: $name"
[ "$preset" = "concise" ] && ok "onboard captures preset by number" || ko "onboard preset: $preset"
[ -f "$COOP_DIR/.coop/config" ] && "$PY" -c 'import json,sys; c=json.load(open(sys.argv[1])); assert c["schema_version"]==1 and "integrations" in c' "$COOP_DIR/.coop/config" && ok "onboard writes valid versioned integration config" || ko "integration config missing/invalid"
[ -f "$COOP_DIR/.coop/agent/mcp.json" ] && ! grep -q 'TODO-\|@latest' "$COOP_DIR/.coop/agent/mcp.json" && ok "onboard generates placeholder-free pinned MCP config" || ko "managed MCP config missing/unpinned"
cp "$COOP_DIR/.coop/user.json" "$COOP_DIR/user-before.json"
printf '\n\n\n\n\n\n\n\n\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1
cmp -s "$COOP_DIR/.coop/user.json" "$COOP_DIR/user-before.json" && ok "config-only edit preserves user profile" || ko "config-only edit changed profile"
# Malformed config fails safely and remains byte-identical.
printf '{broken\n' > "$COOP_DIR/.coop/config"; cp "$COOP_DIR/.coop/config" "$COOP_DIR/config-before"
printf '\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1; bad_rc=$?
[ "$bad_rc" -eq 2 ] && cmp -s "$COOP_DIR/.coop/config" "$COOP_DIR/config-before" && ok "malformed config fails without overwrite" || ko "malformed config was not preserved"
rm "$COOP_DIR/.coop/config"
# Stub a logged-in Azure CLI; accept tenant and explicitly disable Azure DevOps.
mkdir -p "$COOP_DIR/azbin"; cat > "$COOP_DIR/azbin/az" <<'EOF'
#!/bin/sh
printf '%s\n' '{"tenantId":"tenant-detected","name":"Detected Tenant"}'
EOF
chmod +x "$COOP_DIR/azbin/az"
# Windows Python subprocess can't execute a no-extension shell script; provide a .bat twin.
printf '@echo off\r\necho {"tenantId":"tenant-detected","name":"Detected Tenant"}\r\n' > "$COOP_DIR/azbin/az.bat"
if command -v cygpath >/dev/null 2>&1; then
  COOP_AZ_BIN="$(cygpath -w "$COOP_DIR/azbin/az.bat")"
else
  COOP_AZ_BIN="$COOP_DIR/azbin/az"
fi
export COOP_AZ_BIN
printf 'y\n\n\n\nn\n\n\n' | PATH="$COOP_DIR/azbin:$PATH" COOP_AZ_BIN="$COOP_AZ_BIN" "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1
"$PY" - "$COOP_DIR/.coop/config" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); assert c['azure']['tenant_id']=='tenant-detected'; assert c['integrations']['azure_devops'] is False
PY
[ "$?" -eq 0 ] && ok "detected tenant accepted and Azure DevOps disabled" || ko "Azure integration choices incorrect"
# Existing profile alone is incomplete: common helper requires global config too.
rm "$COOP_DIR/.coop/config"
( HOME="$COOP_DIR" COOP_ROOT="$ROOT" bash -c '. "$COOP_ROOT/lib/common.sh"; coop_onboarding_missing' ) && ok "missing global config retriggers onboarding" || ko "missing global config did not retrigger onboarding"
printf '%s\n' '{"schema_version":1,"azure":{"enabled":false,"tenant_id":"","tenant_name":""},"integrations":{},"azure_devops":{"organization":""},"mcp":{"safe_mode":"read_only_first"},"fleet":{"publish_dir":""}}' > "$COOP_DIR/.coop/config"

# --- profile show ---------------------------------------------------------------
show="$(HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile)"
case "$show" in *"Name: Test User"*) ok "profile shows name" ;; *) ko "profile show: $show" ;; esac
case "$show" in *"Communication: concise"*) ok "profile shows preset" ;; *) ko "profile show preset: $show" ;; esac

# --- profile edit ---------------------------------------------------------------
out="$(printf 'Updated\n3\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile --edit --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
preset="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["communication"]["preset"])')"
[ "$name" = "Updated" ] && ok "profile edit updates name" || ko "edit name: $name"
[ "$preset" = "teaching" ] && ok "profile edit updates preset" || ko "edit preset: $preset"

# --- profile reset --------------------------------------------------------------
HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile --reset >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "profile reset exits 0" || ko "profile reset exit: $rc"
[ ! -f "$COOP_DIR/.coop/user.json" ] && ok "profile reset removes user.json" || ko "user.json still exists"

# --- profile show without profile -----------------------------------------------
out="$(HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile 2>&1)"
rc=$?
[ "$rc" -ne 0 ] && ok "profile without user exits non-zero" || ko "expected non-zero exit, got $rc"
case "$out" in *"No COOP profile yet"*) ok "profile without user prints guidance" ;; *) ko "missing guidance: $out" ;; esac

# --- migration from legacy consultant_name in project.yml -----------------------
# Create a fake project with an old consultant_name and no local profile.
mig_dir="$COOP_DIR/migrate-test"
mkdir -p "$mig_dir/.coop"
cat > "$mig_dir/.coop/project.yml" <<'YAML'
profile:
  consultant_name: "Legacy Name"
  organization: "Cooptimize"
YAML
rm -f "$COOP_DIR/.coop/user.json"
out="$(cd "$mig_dir" && printf 'Y\n\n2\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
[ "$name" = "Legacy Name" ] && ok "onboard seeds profile from legacy consultant_name" || ko "migration name: $name"
out="$(printf 'bad/name\nGood Name\n1\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
[ "$name" = "Good Name" ] && ok "invalid name is rejected and re-asked" || ko "name after reject: $name"

exit $fail
