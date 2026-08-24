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

# --- conditional/honest integrations -------------------------------------------
cfg_json() { "$PY" -c 'import json,sys; c=json.load(open(sys.argv[1])); print(json.dumps(c))' "$1"; }

# Helper: fresh dir, run config-only onboarding with scripted answers.
run_config() {
  local dir="$1"; shift
  printf '%s\n' "$@" | HOME="$dir" COOP_DIR="$dir" COOP_AZ_BIN=/nonexistent/az \
    "$PY" "$ROOT/scripts/onboard.py" onboard --config-only 2>"$dir/stderr.txt" >/dev/null
}

# (1) Manual client tenant: wording makes ownership unambiguous.
d1="$(mktemp -d "$COOP_DIR/c1.XXXXXX")"
GUID="11111111-2222-3333-4444-555555555555"
run_config "$d1" "y" "$GUID" "" "" "" "n" ""
grep -q "client" "$d1/stderr.txt" && grep -qi "Cooptimize" "$d1/stderr.txt" \
  && ok "tenant prompt names client vs Cooptimize ownership" || ko "tenant prompt lacks ownership guidance"
grep -q "Fabric and Power BI resources Coop should access" "$d1/stderr.txt" \
  && ok "tenant prompt says whose resources Coop accesses" || ko "tenant prompt vague about resource ownership"
tenant_id="$(cfg_json "$d1/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure"]["tenant_id"])')"
[ "$tenant_id" = "$GUID" ] && ok "manually supplied client tenant is stored" || ko "manual tenant lost: $tenant_id"
power_bi="$(cfg_json "$d1/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"]["power_bi"])')"
[ "$power_bi" = "True" ] && ok "Power BI MCP can be enabled WITH a tenant" || ko "power_bi should be True with tenant: $power_bi"
grep -q "Review" "$d1/stderr.txt" && grep -q ".coop/config" "$d1/stderr.txt" \
  && ok "summary shows review block and destination path" || ko "summary missing before save"
grep -q "$GUID" "$d1/stderr.txt" \
  && ok "summary echoes the configured tenant" || ko "summary omits tenant"

# (2) Detected tenant prompt uses the access-oriented question.
d2="$(mktemp -d "$COOP_DIR/c2.XXXXXX")"
out2="$(printf 'y\n\n\nn\n\n' | PATH="$COOP_DIR/azbin:$PATH" HOME="$d2" COOP_DIR="$d2" COOP_AZ_BIN="$COOP_AZ_BIN" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only 2>&1 >/dev/null)"
case "$out2" in
  *"Use this tenant for Coop's Fabric and Power BI access?"*)
    ok "detected-tenant prompt asks about Fabric/Power BI access" ;;
  *) ko "detected-tenant prompt wrong: $out2" ;;
esac

# (3) Tenant declined -> Power BI MCP cannot be enabled and says why.
d3="$(mktemp -d "$COOP_DIR/c3.XXXXXX")"
run_config "$d3" "n" "" "" "n" ""
grep -q "Power BI MCP requires an Azure tenant and will remain disabled." "$d3/stderr.txt" \
  && ok "Power BI MCP unavailable-without-tenant message shown" || ko "missing Power BI disabled message"
case "$(cat "$d3/stderr.txt")" in
  *"Enable Power BI MCP"*) ko "Power BI enable prompt shown without a tenant" ;;
  *) ok "no Power BI enable prompt without a tenant" ;;
esac
power_bi="$(cfg_json "$d3/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"]["power_bi"])')"
[ "$power_bi" = "False" ] && ok "Power BI MCP stored explicitly disabled without tenant" || ko "power_bi should be False: $power_bi"

# (4) Blank Azure DevOps organization is rejected, then a URL is accepted.
d4="$(mktemp -d "$COOP_DIR/c4.XXXXXX")"
run_config "$d4" "y" "$GUID" "" "" "" "y" "" "y" "https://dev.azure.com/myorg" ""
case "$(cat "$d4/stderr.txt")" in
  *"cannot be empty"*) ok "blank Azure DevOps organization rejected" ;;
  *) ko "blank ADO organization accepted: $(tail -3 "$d4/stderr.txt")" ;;
esac
org="$(cfg_json "$d4/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure_devops"]["organization"])')"
[ "$org" = "https://dev.azure.com/myorg" ] && ok "ADO organization URL accepted" || ko "ADO org: $org"

# (5) Giving up on the organization disables the integration instead of saving it broken.
d5="$(mktemp -d "$COOP_DIR/c5.XXXXXX")"
run_config "$d5" "y" "$GUID" "" "" "" "y" "" "n" ""
ado_enabled="$(cfg_json "$d5/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"]["azure_devops"])')"
[ "$ado_enabled" = "False" ] && ok "backing out of ADO org prompt disables the integration" || ko "ADO saved enabled without org: $ado_enabled"

# (6) Short organization name is also accepted.
d6="$(mktemp -d "$COOP_DIR/c6.XXXXXX")"
run_config "$d6" "y" "$GUID" "" "" "" "y" "myorg" ""
org="$(cfg_json "$d6/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure_devops"]["organization"])')"
[ "$org" = "myorg" ] && ok "short ADO organization name accepted" || ko "short org: $org"

# (7) All optional integrations declined.
d7="$(mktemp -d "$COOP_DIR/c7.XXXXXX")"
run_config "$d7" "n" "n" "n" "n" "n"
"$PY" - "$d7/.coop/config" <<'PYEOF'
import json,sys
c=json.load(open(sys.argv[1]))
i=c["integrations"]
assert not any(i[k] for k in i), i
PYEOF
[ "$?" -eq 0 ] && ok "all optional integrations can be declined" || ko "declined integrations not all False"

# (8) Editing an existing configuration updates it in place.
d8="$(mktemp -d "$COOP_DIR/c8.XXXXXX")"
run_config "$d8" "y" "$GUID" "n" "n" "n" "n" "n"
before_profile="x"; [ -f "$d8/.coop/user.json" ] && before_profile="exists"
run_config "$d8" "n" "n" "y" "n" "n" "y"
learn="$(cfg_json "$d8/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"]["microsoft_learn"])')"
fabric="$(cfg_json "$d8/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"]["fabric"])')"
[ "$learn" = "True" ] && [ "$fabric" = "False" ] && ok "editing an existing configuration updates integrations" || ko "edit: learn=$learn fabric=$fabric"
[ ! -f "$d8/.coop/user.json" ] && ok "config-only edit still never creates a profile" || ko "config-only created a profile"

# (9) Completion messages differ by invocation context.
d9a="$(mktemp -d "$COOP_DIR/c9a.XXXXXX")"
out9="$(printf '\n1\nn\n\n\nn\n\n' | HOME="$d9a" COOP_DIR="$d9a" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard 2>&1 >/dev/null)"
case "$out9" in
  *"Setup complete. Run 'coop' to start."*) ok "explicit onboard ends with start instructions" ;;
  *) ko "explicit onboard completion message missing: $(tail -2 <<<"$out9")" ;;
esac
d9b="$(mktemp -d "$COOP_DIR/c9b.XXXXXX")"
out10="$(printf '\n1\ny\n%s\n\n\nn\n\n' "$GUID" | HOME="$d9b" COOP_DIR="$d9b" COOP_AZ_BIN=/nonexistent/az COOP_ONBOARD_FROM_LAUNCH=1 \
  "$PY" "$ROOT/scripts/onboard.py" onboard 2>&1 >/dev/null)"
case "$out10" in
  *"Setup complete. Starting Coop"*) ok "launch-triggered onboarding announces startup" ;;
  *) ko "launch completion message missing: $(tail -2 <<<"$out10")" ;;
esac

exit $fail
