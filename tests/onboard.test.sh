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
export COOP_AZ_BIN=/nonexistent/az
# The client platform question (master plan section 8 item 7) is answered from
# the environment here, so the scripted answers below keep their positions; the
# platform cases at the end of this file unset it to exercise the prompt itself.
export COOP_CLIENT_PLATFORM=fabric

run_onboard() {
  HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" "$@"
}

# The public dispatcher is bin/coop.ps1 (master plan S1: one implementation, in
# PowerShell); pwsh on macOS/Linux and CI, Windows PowerShell as the fallback.
PWSH="$(command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null || true)"
[ -z "$PWSH" ] && { echo "pwsh (PowerShell 7) required: the coop dispatcher is bin/coop.ps1"; exit 1; }
COOP_PS1="$ROOT/bin/coop.ps1"
if command -v cygpath >/dev/null 2>&1; then COOP_PS1="$(cygpath -w "$COOP_PS1")"; fi

# --- first-run onboarding ---------------------------------------------------------
out="$(printf 'Test User\n1\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
preset="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["communication"]["preset"])')"
[ "$name" = "Test User" ] && ok "onboard captures name" || ko "onboard name: $name"
[ "$preset" = "concise" ] && ok "onboard captures preset by number" || ko "onboard preset: $preset"
[ -f "$COOP_DIR/.coop/config" ] && "$PY" -c 'import json,sys; c=json.load(open(sys.argv[1])); assert c["schema_version"]==1 and "integrations" in c' "$COOP_DIR/.coop/config" && ok "onboard writes valid versioned integration config" || ko "integration config missing/invalid"
[ -f "$COOP_DIR/.coop/agent/mcp-adapter.json" ] && ! grep -q 'TODO-\|@latest' "$COOP_DIR/.coop/agent/mcp-adapter.json" && ok "onboard generates placeholder-free pinned MCP config" || ko "managed MCP config missing/unpinned"

# Exercise the public dispatcher, not only onboard.py directly. The launcher
# must supply onboard.py's required `onboard` subcommand before user flags.
LAUNCH_DIR="$COOP_DIR/launcher"; mkdir -p "$LAUNCH_DIR"
launch_out="$(printf 'Launcher User\n1\n' | env HOME="$LAUNCH_DIR" USERPROFILE="$LAUNCH_DIR" COOP_DIR="$LAUNCH_DIR" COOP_AZ_BIN=/nonexistent/az \
  "$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$COOP_PS1" onboard --json 2>/dev/null)"
launch_name="$(printf '%s' "$launch_out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
[ "$launch_name" = "Launcher User" ] && [ -f "$LAUNCH_DIR/.coop/user.json" ] && ok "coop onboard dispatcher supplies the required subcommand" || ko "coop onboard dispatcher failed"

cp "$COOP_DIR/.coop/user.json" "$COOP_DIR/user-before.json"
printf '\n\n\n\n\n\n\n\n\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1
cmp -s "$COOP_DIR/.coop/user.json" "$COOP_DIR/user-before.json" && ok "config-only edit preserves user profile" || ko "config-only edit changed profile"
# A repeat onboarding run (including install repairing a missing config) should
# not ask an already-complete user profile again unless --edit was requested.
rm "$COOP_DIR/.coop/config"
repeat_out="$(printf 'n\n' | env HOME="$COOP_DIR" COOP_DIR="$COOP_DIR" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard 2>&1 >/dev/null)"
case "$repeat_out" in
  *"What should COOP call you?"*) ko "repeat onboarding unnecessarily re-asked the profile" ;;
  *) ok "repeat onboarding keeps the completed user profile" ;;
esac
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
printf 'y\n\n\nn\n\n\n' | PATH="$COOP_DIR/azbin:$PATH" COOP_AZ_BIN="$COOP_AZ_BIN" "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1
"$PY" - "$COOP_DIR/.coop/config" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); assert c['azure']['tenant_id']=='tenant-detected'; assert c['integrations']['azure_devops'] is False
PY
[ "$?" -eq 0 ] && ok "detected tenant accepted and Azure DevOps disabled" || ko "Azure integration choices incorrect"
# Existing profile alone is incomplete: common helper requires global config too.
rm "$COOP_DIR/.coop/config"
( HOME="$COOP_DIR" USERPROFILE="$COOP_DIR" COOP_ROOT="$ROOT" "$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command '. (Join-Path $env:COOP_ROOT "lib/common.ps1"); if (Test-CoopOnboardingMissing) { exit 0 } else { exit 1 }' ) && ok "missing global config retriggers onboarding" || ko "missing global config did not retrigger onboarding"
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
out="$(printf 'bad/name\nGood Name\n1\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --edit --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
[ "$name" = "Good Name" ] && ok "invalid name is rejected and re-asked" || ko "name after reject: $name"

# --- invalid saved profile name + EOF must abort, not loop forever -------------
# A hang guard (tests/fixtures/timeout.py, 10 s watchdog): extended lane only
# (COOP_TEST_EXTENDED=1, #96).
if [ "${COOP_TEST_EXTENDED:-0}" = "1" ]; then
  mkdir -p "$COOP_DIR/.coop"
  printf '%s\n' '{"schema_version":1,"name":"bad/name","communication":{"preset":"balanced","custom_instructions":""}}' > "$COOP_DIR/.coop/user.json"
  inv_out="$(GUARD_HOME="$COOP_DIR" "$PY" "$ROOT/tests/fixtures/timeout.py" 10 \
    env HOME="$COOP_DIR" COOP_DIR="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard)"; inv_rc=$?
  [ "$inv_rc" -ne 0 ] && ok "invalid saved profile name at EOF aborts non-zero" || { ko "EOF+invalid name did not abort (rc=$inv_rc)"; }
  case "$inv_out" in
    *"aborting onboarding"*) ok "abort message explains the saved-name problem" ;;
    *) ko "missing abort explanation: $(printf '%s' "$inv_out" | tail -2)" ;;
  esac
else
  printf '  - skipped in the gate lane: %s (COOP_TEST_EXTENDED=1 runs it)\n' \
    "invalid saved profile name at EOF aborts (a 10 s hang guard)"
fi

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
run_config "$d1" "y" "$GUID" "" "" "n" ""
grep -qi "client" "$d1/stderr.txt" && grep -qi "Cooptimize" "$d1/stderr.txt" \
  && ok "tenant prompt names client vs Cooptimize ownership" || ko "tenant prompt lacks ownership guidance"
grep -q "Fabric and Power BI resources Coop should access" "$d1/stderr.txt" \
  && ok "tenant prompt says whose resources Coop accesses" || ko "tenant prompt vague about resource ownership"
tenant_id="$(cfg_json "$d1/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure"]["tenant_id"])')"
[ "$tenant_id" = "$GUID" ] && ok "manually supplied client tenant is stored" || ko "manual tenant lost: $tenant_id"
tenant_purpose="$(cfg_json "$d1/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure"]["purpose"])')"
[ "$tenant_purpose" = "client_resources" ] && ok "Azure tenant is machine-labeled client-only" || ko "Azure tenant purpose is ambiguous: $tenant_purpose"
grep -q "Do not enter the Cooptimize tenant here" "$d1/stderr.txt" \
  && grep -q "separate sign-in" "$d1/stderr.txt" \
  && ok "onboarding preserves the client/Cooptimize identity boundary" || ko "dual-identity boundary is not explicit"
# powerbi-mcp-server is retired (#93): no toggle, no saved key, and the review
# summary never claims a server that is not generated. Modeling MCP stays.
case "$(cat "$d1/stderr.txt")" in
  *"Enable Power BI MCP?"*) ko "retired Power BI MCP toggle still offered with a tenant" ;;
  *) ok "no retired Power BI MCP toggle with a tenant" ;;
esac
cfg_json "$d1/.coop/config" | "$PY" -c 'import json,sys; sys.exit("power_bi" in json.load(sys.stdin)["integrations"])' \
  && ok "no retired power_bi integration saved with a tenant" || ko "retired power_bi integration saved with a tenant"
grep -q '^- Enabled:.*Power BI MCP' "$d1/stderr.txt" \
  && ko "review summary lists retired Power BI MCP as enabled: $(grep '^- Enabled:' "$d1/stderr.txt")" \
  || ok "review summary does not list Power BI MCP as enabled"
grep -q "Review" "$d1/stderr.txt" && grep -q "Destination:" "$d1/stderr.txt" \
  && ok "summary shows review block and destination path" || ko "summary missing before save"
grep -q "$GUID" "$d1/stderr.txt" \
  && ok "summary echoes the configured tenant" || ko "summary omits tenant"
grep -q "Microsoft Entra ID > Overview > Tenant ID" "$d1/stderr.txt" \
  && ok "manual tenant prompt explains where to find the ID" || ko "manual tenant prompt lacks inline lookup instructions"

# (2) Detected tenant prompt uses the access-oriented question.
d2="$(mktemp -d "$COOP_DIR/c2.XXXXXX")"
out2="$(printf 'y\n\n\n\n\n' | env PATH="$COOP_DIR/azbin:$PATH" HOME="$d2" COOP_DIR="$d2" COOP_AZ_BIN="$COOP_AZ_BIN" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only 2>&1 >/dev/null)"
case "$out2" in
  *"Use this as the client resource tenant for Fabric and Power BI?"*)
    ok "detected-tenant prompt asks about Fabric/Power BI access" ;;
  *) ko "detected-tenant prompt wrong: $out2" ;;
esac

# (2b) Installed-but-signed-out Azure CLI offers login, then detects the tenant.
d2b="$(mktemp -d "$COOP_DIR/c2b.XXXXXX")"
az_login_stub="$d2b/az-login-stub"
cat > "$az_login_stub" <<'SH'
#!/bin/sh
state="${COOP_TEST_AZ_STATE:?}"
if [ "$1" = "login" ]; then
  touch "$state"
  printf '%s\n' '[{"tenantId":"tenant-after-login","name":"Signed In Tenant"}]'
  exit 0
fi
# Regression: Fabric-only/no-subscription sign-ins may never make account show
# succeed. Coop must preserve the tenant returned directly by `az login`.
exit 1
SH
chmod +x "$az_login_stub"
az_login_state="$d2b/signed-in"
if command -v cygpath >/dev/null 2>&1; then
  az_login_stub_bat="$d2b/az-login-stub.bat"
  printf '%s\r\n' \
    '@echo off' \
    'if "%1"=="login" (type nul > "%COOP_TEST_AZ_STATE%" & echo [{"tenantId":"tenant-after-login","name":"Signed In Tenant"}] & exit /b 0)' \
    'exit /b 1' > "$az_login_stub_bat"
  az_login_stub="$(cygpath -w "$az_login_stub_bat")"
  az_login_state="$(cygpath -w "$az_login_state")"
fi
out2b="$(printf 'y\ny\n\n\nn\n\n' | HOME="$d2b" COOP_DIR="$d2b" COOP_AZ_BIN="$az_login_stub" COOP_TEST_AZ_STATE="$az_login_state" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only 2>&1 >/dev/null)"
tenant2b="$(cfg_json "$d2b/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure"]["tenant_id"])')"
case "$out2b" in
  *"Sign in now so Coop can detect the client tenant automatically?"*)
    [ "$tenant2b" = "tenant-after-login" ] && [[ "$out2b" == *"Signed in. Detected client tenant"* ]] \
      && ok "Azure login JSON detects no-subscription tenant and confirms success" \
      || ko "tenant not detected directly from login: tenant=$tenant2b output=$out2b" ;;
  *) ko "signed-out Azure CLI did not offer automatic login: $out2b" ;;
esac

# (2c) Multiple tenants returned by login require an explicit client selection.
d2c="$(mktemp -d "$COOP_DIR/c2c.XXXXXX")"
az_multi_stub="$d2c/az-multi-stub"
cat > "$az_multi_stub" <<'SH'
#!/bin/sh
if [ "$1" = "login" ]; then
  printf '%s\n' '[{"tenantId":"tenant-one","name":"One"},{"tenantId":"tenant-two","name":"Two"}]'
  exit 0
fi
exit 1
SH
chmod +x "$az_multi_stub"
if command -v cygpath >/dev/null 2>&1; then
  az_multi_stub_bat="$d2c/az-multi-stub.bat"
  printf '%s\r\n' \
    '@echo off' \
    'if "%1"=="login" (echo [{"tenantId":"tenant-one","name":"One"},{"tenantId":"tenant-two","name":"Two"}] & exit /b 0)' \
    'exit /b 1' > "$az_multi_stub_bat"
  az_multi_stub="$(cygpath -w "$az_multi_stub_bat")"
fi
out2c="$(printf 'y\n2\n\n\nn\n\n' | HOME="$d2c" COOP_DIR="$d2c" COOP_AZ_BIN="$az_multi_stub" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only 2>&1 >/dev/null)"
tenant2c="$(cfg_json "$d2c/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure"]["tenant_id"])')"
[ "$tenant2c" = "tenant-two" ] && [[ "$out2c" == *"Which tenant owns the client's Fabric and Power BI environment?"* ]] \
  && ok "multiple Azure tenants require an explicit client selection" \
  || ko "multiple-tenant selection failed: tenant=$tenant2c output=$out2c"

# (2d) Failed browser auth offers device-code recovery and uses its login JSON.
d2d="$(mktemp -d "$COOP_DIR/c2d.XXXXXX")"
az_device_stub="$d2d/az-device-stub"
cat > "$az_device_stub" <<'SH'
#!/bin/sh
if [ "$1" = "login" ]; then
  case " $* " in
    *" --use-device-code "*) printf '%s\n' '[{"tenantId":"tenant-device","name":"Device Tenant"}]'; exit 0 ;;
    *) exit 1 ;;
  esac
fi
exit 1
SH
chmod +x "$az_device_stub"
if command -v cygpath >/dev/null 2>&1; then
  az_device_stub_bat="$d2d/az-device-stub.bat"
  printf '%s\r\n' \
    '@echo off' \
    'if "%1"=="login" echo %* | findstr /c:"--use-device-code" >nul && (echo [{"tenantId":"tenant-device","name":"Device Tenant"}] & exit /b 0)' \
    'exit /b 1' > "$az_device_stub_bat"
  az_device_stub="$(cygpath -w "$az_device_stub_bat")"
fi
out2d="$(printf 'y\ny\n\n\nn\n\n' | HOME="$d2d" COOP_DIR="$d2d" COOP_AZ_BIN="$az_device_stub" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only 2>&1 >/dev/null)"
tenant2d="$(cfg_json "$d2d/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure"]["tenant_id"])')"
[ "$tenant2d" = "tenant-device" ] && [[ "$out2d" == *"Try again with a device code?"* ]] \
  && ok "device-code retry recovers a failed browser sign-in" \
  || ko "device-code recovery failed: tenant=$tenant2d output=$out2d"

# (3) Tenant declined -> nothing about the retired Power BI MCP: no prompt, no
# "omitted" line, and no advice to set a tenant for a server Coop never writes.
d3="$(mktemp -d "$COOP_DIR/c3.XXXXXX")"
run_config "$d3" "n" "" "" "n" ""
case "$(cat "$d3/stderr.txt")" in
  *"Enable Power BI MCP"*) ko "Power BI enable prompt shown without a tenant" ;;
  *"Power BI MCP requires an Azure tenant"*|*"Omitted: Power BI MCP"*|*"Power BI MCP is omitted"*)
    ko "retired Power BI MCP still reported as needing a tenant" ;;
  *) ok "no retired Power BI MCP prompt or tenant advice without a tenant" ;;
esac
cfg_json "$d3/.coop/config" | "$PY" -c 'import json,sys; sys.exit("power_bi" in json.load(sys.stdin)["integrations"])' \
  && ok "no retired power_bi integration saved without a tenant" || ko "retired power_bi integration saved without a tenant"

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
run_config "$d7" "n" "n" "n" "n" "n" "n" "n"
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
run_config "$d8" "n" "n" "n" "n" "n" "y"
learn="$(cfg_json "$d8/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"]["microsoft_learn"])')"
fabric="$(cfg_json "$d8/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"]["fabric"])')"
[ "$learn" = "True" ] && [ "$fabric" = "False" ] && ok "editing an existing configuration updates integrations" || ko "edit: learn=$learn fabric=$fabric"
[ ! -f "$d8/.coop/user.json" ] && ok "config-only edit still never creates a profile" || ko "config-only created a profile"

# (8b) A config saved before #93 (power_bi on, tenant set) is re-edited: the
# retired toggle is not offered or summarized, and its stale key is dropped.
d8b="$(mktemp -d "$COOP_DIR/c8b.XXXXXX")"; mkdir -p "$d8b/.coop"
printf '{"schema_version":1,"azure":{"enabled":true,"purpose":"client_resources","tenant_id":"%s","tenant_name":""},"integrations":{"fabric":true,"fabric_sql_endpoint":true,"power_bi":true,"power_bi_modeling":true,"azure_devops":false,"microsoft_learn":true},"azure_devops":{"organization":""},"mcp":{"safe_mode":"read_only_first"},"fleet":{"publish_dir":""}}\n' "$GUID" > "$d8b/.coop/config"
run_config "$d8b" "n" "" "" "" "" "" ""
case "$(cat "$d8b/stderr.txt")" in
  *"Enable Power BI MCP?"*) ko "legacy config re-edit offers the retired Power BI MCP toggle" ;;
  *) ok "legacy config re-edit does not offer the retired Power BI MCP toggle" ;;
esac
grep -q '^- Enabled:.*Power BI MCP' "$d8b/stderr.txt" \
  && ko "legacy config review lists retired Power BI MCP: $(grep '^- Enabled:' "$d8b/stderr.txt")" \
  || ok "legacy config review does not list Power BI MCP as enabled"
"$PY" - "$d8b/.coop/config" <<'PYEOF'
import json,sys
i=json.load(open(sys.argv[1]))["integrations"]
assert "power_bi" not in i and i["power_bi_modeling"] is True, i
PYEOF
[ "$?" -eq 0 ] && ok "legacy power_bi key dropped, Power BI Modeling MCP kept" || ko "legacy power_bi key kept or modeling lost"

# (9) Completion messages differ by invocation context.
d9a="$(mktemp -d "$COOP_DIR/c9a.XXXXXX")"
out9="$(printf '\n1\nn\n\n\nn\n\n' | HOME="$d9a" COOP_DIR="$d9a" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard 2>&1 >/dev/null)"
case "$out9" in
  *"Connect Coop to client Microsoft Fabric and Power BI now?"*"Using the recommended integrations."*)
    case "$out9" in
      *"Enable Azure DevOps MCP?"*) ko "fresh setup still asks expert integration toggles" ;;
      *) ok "fresh setup uses one cloud choice and recommended integrations" ;;
    esac ;;
  *) ko "fresh setup did not use the streamlined path: $out9" ;;
esac
case "$out9" in
  *"Power BI MCP ("*|*"Power BI MCP is omitted"*) ko "quick start without a tenant still reports the retired Power BI MCP" ;;
  *) ok "quick start without a tenant does not report the retired Power BI MCP" ;;
esac
case "$out9" in
  *"Setup complete. Run 'coop' to start."*) ok "explicit onboard ends with start instructions" ;;
  *) ko "explicit onboard completion message missing: $(tail -2 <<<"$out9")" ;;
esac
# The launch no longer runs the wizard (master plan FR1): the old
# COOP_ONBOARD_FROM_LAUNCH announcement is gone and the message is the same.
d9b="$(mktemp -d "$COOP_DIR/c9b.XXXXXX")"
out10="$(printf '\n1\ny\n%s\n\n\nn\n\n' "$GUID" | HOME="$d9b" COOP_DIR="$d9b" COOP_AZ_BIN=/nonexistent/az COOP_ONBOARD_FROM_LAUNCH=1 \
  "$PY" "$ROOT/scripts/onboard.py" onboard 2>&1 >/dev/null)"
case "$out10" in
  *"Starting Coop"*) ko "onboard still announces a launch it no longer belongs to: $(tail -2 <<<"$out10")" ;;
  *"Setup complete. Run 'coop' to start."*) ok "onboard ends with start instructions whatever the environment says" ;;
  *) ko "completion message missing: $(tail -2 <<<"$out10")" ;;
esac
# Quick start WITH a client tenant: the review lists Power BI Modeling MCP, never
# the retired Power BI MCP that sync no longer writes (#93).
d9c="$(mktemp -d "$COOP_DIR/c9c.XXXXXX")"
out11="$(printf 'Quick User\n1\ny\ny\n%s\nn\n' "$GUID" | HOME="$d9c" COOP_DIR="$d9c" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard 2>&1 >/dev/null)"
enabled11="$(grep '^- Enabled:' <<<"$out11")"
tenant9c="$(cfg_json "$d9c/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["azure"]["tenant_id"])')"
case "$enabled11" in
  *"Power BI MCP"*) ko "quick start with a tenant lists the retired Power BI MCP as enabled: $enabled11" ;;
  *"Power BI Modeling MCP"*) [ "$tenant9c" = "$GUID" ] \
    && ok "quick start with a tenant lists Power BI Modeling MCP, not the retired server" \
    || ko "quick start did not save the tenant: $tenant9c" ;;
  *) ko "quick start review line missing: $enabled11" ;;
esac

# --- client platform: install choice, machine default, Azure SQL defaults -----
unset COOP_CLIENT_PLATFORM
platform_of() { cfg_json "$1/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin).get("client",{}).get("platform",""))'; }
integration_of() { cfg_json "$1/.coop/config" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["integrations"].get(sys.argv[1]))' "$2"; }

# (p1) Quick start asks the platform first; answer 2 = Azure SQL turns the
# Fabric servers off with an honest reason, and the choice is saved.
dp1="$(mktemp -d "$COOP_DIR/p1.XXXXXX")"
printf 'Plat User\n1\n2\n' | HOME="$dp1" COOP_DIR="$dp1" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>"$dp1/stderr.txt" >/dev/null
grep -q "Does this client run on Fabric, Azure SQL, or both?" "$dp1/stderr.txt" \
  && ok "first onboarding asks the client platform question" || ko "platform question missing from first onboarding"
[ "$(platform_of "$dp1")" = "azure_sql" ] && ok "answer 2 saves client.platform azure_sql" || ko "platform not saved: $(platform_of "$dp1")"
[ "$(integration_of "$dp1" fabric)" = "False" ] && [ "$(integration_of "$dp1" fabric_sql_endpoint)" = "False" ] \
  && ok "Azure SQL quick start defaults the Fabric MCP servers off" || ko "Fabric servers enabled on an Azure SQL quick start"
grep -q "Fabric MCP (Azure SQL client)" "$dp1/stderr.txt" && ok "review names the Azure SQL reason" || ko "review lacks the Azure SQL reason"
grep -q "Azure SQL resources Coop should access" "$dp1/stderr.txt" && ok "tenant wording follows the platform" || ko "tenant wording still says Fabric on an Azure SQL client"

# (p2) Editing the config re-asks with the saved value as the default (EOF keeps it).
printf '\n\n\n\n\n\n\n\n\n' | HOME="$dp1" COOP_DIR="$dp1" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only 2>"$dp1/stderr2.txt" >/dev/null
[ "$(platform_of "$dp1")" = "azure_sql" ] && ok "config-only edit keeps the saved platform as default" || ko "config-only edit lost the platform"
grep -q "Does this client run on" "$dp1/stderr2.txt" && ok "config-only edit re-asks the platform" || ko "config-only edit skipped the platform question"

# (p3) `platform --set` (coop install --platform, non-interactive) writes only the
# key, creating a minimal config, and the following onboarding does not re-ask.
dp3="$(mktemp -d "$COOP_DIR/p3.XXXXXX")"
HOME="$dp3" COOP_DIR="$dp3" "$PY" "$ROOT/scripts/onboard.py" platform --set both >/dev/null 2>&1
[ "$(platform_of "$dp3")" = "both" ] && ok "platform --set writes client.platform on a fresh machine" || ko "platform --set failed"
shown="$(HOME="$dp3" COOP_DIR="$dp3" "$PY" "$ROOT/scripts/onboard.py" platform --show 2>/dev/null)"
[ "$shown" = "both" ] && ok "platform --show prints the saved value" || ko "platform --show printed: $shown"
printf 'Both User\n1\n' | HOME="$dp3" COOP_DIR="$dp3" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>"$dp3/stderr.txt" >/dev/null
if grep -q "Does this client run on" "$dp3/stderr.txt"; then ko "onboarding re-asked a platform saved at install"; else ok "onboarding keeps the install-time platform without asking"; fi
grep -q "Using the recommended integrations" "$dp3/stderr.txt" && ok "a config holding only the platform still takes the quick start" || ko "platform-only config skipped the quick start"
[ "$(platform_of "$dp3")" = "both" ] && ok "onboarding preserves client.platform" || ko "onboarding dropped client.platform"
HOME="$dp3" COOP_DIR="$dp3" "$PY" "$ROOT/scripts/onboard.py" platform --set mainframe >/dev/null 2>&1 && ko "platform --set accepted an unknown value" || ok "platform --set rejects an unknown value"
[ "$(platform_of "$dp3")" = "both" ] && ok "a rejected value leaves the saved platform alone" || ko "rejected value changed the platform"

# (p4) COOP_CLIENT_PLATFORM and --platform answer without a prompt; the saved
# config keeps every other key (knowledge repos survive a platform change).
dp4="$(mktemp -d "$COOP_DIR/p4.XXXXXX")"
printf 'Env User\n1\n' | HOME="$dp4" COOP_DIR="$dp4" COOP_AZ_BIN=/nonexistent/az COOP_CLIENT_PLATFORM=azure-sql \
  "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>"$dp4/stderr.txt" >/dev/null
[ "$(platform_of "$dp4")" = "azure_sql" ] && ok "COOP_CLIENT_PLATFORM answers the question (spelling normalized)" || ko "env platform not applied: $(platform_of "$dp4")"
if grep -q "Does this client run on" "$dp4/stderr.txt"; then ko "env answer still prompted"; else ok "env answer suppresses the prompt"; fi
printf '\n\n\n\n\n\n\n\n' | HOME="$dp4" COOP_DIR="$dp4" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only --platform fabric 2>/dev/null >/dev/null
[ "$(platform_of "$dp4")" = "fabric" ] && ok "--platform overrides the saved value" || ko "--platform ignored: $(platform_of "$dp4")"
HOME="$dp4" COOP_DIR="$dp4" "$PY" "$ROOT/scripts/onboard.py" onboard --config-only --platform mainframe </dev/null >/dev/null 2>&1 && ko "--platform accepted an unknown value" || ok "--platform rejects an unknown value"
"$PY" - "$dp4/.coop/config" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["knowledge"] = {"enabled": True, "repos": [{"url": "https://example.invalid/kb.git", "local_path": "~/.coop/knowledge/kb"}]}
json.dump(c, open(p, "w"))
PY
HOME="$dp4" COOP_DIR="$dp4" "$PY" "$ROOT/scripts/onboard.py" platform --set both >/dev/null 2>&1
cfg_json "$dp4/.coop/config" | grep -q 'kb.git' && ok "platform --set preserves the other config keys" || ko "platform --set dropped other keys"

# (p5) On an onboarded machine `onboard --platform X` is a one-line switch: no
# question is asked, the profile and integrations stay as they were.
before="$(cfg_json "$dp4/.coop/config" | "$PY" -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["integrations"], sort_keys=True))')"
HOME="$dp4" COOP_DIR="$dp4" COOP_AZ_BIN=/nonexistent/az "$PY" "$ROOT/scripts/onboard.py" onboard --platform azure_sql </dev/null >/dev/null 2>"$dp4/stderr5.txt"
rc=$?
[ "$rc" = 0 ] && [ "$(platform_of "$dp4")" = "azure_sql" ] && ok "onboard --platform switches an onboarded machine without a prompt" || ko "onboard --platform switch failed (rc $rc): $(cat "$dp4/stderr5.txt")"
after="$(cfg_json "$dp4/.coop/config" | "$PY" -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["integrations"], sort_keys=True))')"
[ "$before" = "$after" ] && ok "the switch leaves integrations alone" || ko "the switch changed integrations"
grep -q "Integrations are unchanged" "$dp4/stderr5.txt" && ok "the switch says how to review integrations" || ko "switch message missing"
cfg_json "$dp4/.coop/config" | grep -q 'kb.git' && ok "the switch preserves the other config keys" || ko "the switch dropped other keys"

# --- the machine-level profile (master plan P1) -------------------------------------
# `coop onboard --machine` writes name + communication to COOP_MACHINE_DIR/user.json
# (a fixture folder; never %ProgramData% or /etc here), nothing client-shaped; a
# Windows user with no profile reads it, and its own profile wins.
mp="$(mktemp -d)"; mdir="$mp/machine"; mkdir -p "$mdir"
printf 'Joel Leichty\n1\n' | HOME="$mp" COOP_DIR="$mp" COOP_MACHINE_DIR="$mdir" COOP_AZ_BIN=/nonexistent/az \
  "$PY" "$ROOT/scripts/onboard.py" onboard --machine --json >"$mp/m.json" 2>"$mp/m.txt"
[ -f "$mdir/user.json" ] && ok "onboard --machine writes the machine profile" || ko "machine profile missing: $(cat "$mp/m.txt")"
[ ! -f "$mp/.coop/user.json" ] && ok "onboard --machine writes no per-user profile" || ko "--machine wrote the per-user file"
m_keys="$("$PY" -c 'import json,sys; print(",".join(sorted(json.load(open(sys.argv[1])).keys())))' "$mdir/user.json")"
[ "$m_keys" = "communication,name,schema_version" ] && ok "machine profile holds only name, communication and the schema" || ko "machine profile keys: $m_keys"
grep -q "never holds a client" "$mp/m.txt" && ok "--machine says what the file never holds" || ko "--machine intro missing"
# No per-user file: coop profile shows the machine name and names the file.
p_out="$(HOME="$mp" COOP_DIR="$mp" COOP_MACHINE_DIR="$mdir" "$PY" "$ROOT/scripts/onboard.py" profile 2>/dev/null)"
case "$p_out" in *"Name: Joel Leichty"*"$mdir/user.json"*) ok "coop profile falls back to the machine profile and names the file" ;; *) ko "profile fallback: $p_out" ;; esac
# A fresh per-user onboarding offers the machine name as the default (Enter keeps it).
printf '\n2\n' | HOME="$mp" COOP_DIR="$mp" COOP_MACHINE_DIR="$mdir" COOP_AZ_BIN=/nonexistent/az "$PY" "$ROOT/scripts/onboard.py" onboard >/dev/null 2>"$mp/o.txt"
u_name="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$mp/.coop/user.json" 2>/dev/null)"
[ "$u_name" = "Joel Leichty" ] && ok "per-user onboarding defaults the name to the machine profile" || ko "per-user default name: '$u_name' ($(cat "$mp/o.txt" | tail -n 3))"
u_preset="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["communication"]["preset"])' "$mp/.coop/user.json" 2>/dev/null)"
p_out="$(HOME="$mp" COOP_DIR="$mp" COOP_MACHINE_DIR="$mdir" "$PY" "$ROOT/scripts/onboard.py" profile 2>/dev/null)"
case "$p_out" in *"Communication: $u_preset"*"$mp/.coop/user.json"*) ok "the per-user profile wins over the machine one" ;; *) ko "per-user precedence: $p_out" ;; esac
HOME="$mp" COOP_DIR="$mp" COOP_MACHINE_DIR="$mdir" "$PY" "$ROOT/scripts/onboard.py" onboard --machine --reset >/dev/null 2>&1
[ ! -f "$mdir/user.json" ] && ok "onboard --machine --reset removes the machine profile" || ko "machine reset left the file"
rm -rf "$mp"

exit $fail
