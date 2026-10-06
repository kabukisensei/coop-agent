#!/usr/bin/env bash
#
# Tests for lib/init_wizard.py (coop init guided wizard).
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
[ -z "$PY" ] && { echo "python3 required"; exit 1; }

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# C1: `coop init` refuses to create a contract below one that already covers the
# folder, so a foreign .coop/project.yml above the temp root would fail every
# case here. Skip loudly instead of reporting a false failure.
probe="$TMP"
while [ "$probe" != "/" ] && [ -n "$probe" ]; do
  probe="$(dirname "$probe")"
  if [ -f "$probe/.coop/project.yml" ]; then
    echo "  SKIP init-wizard tests: a foreign contract covers the temp dir: $probe/.coop/project.yml"
    exit 0
  fi
done

# `coop init` is dispatched by bin/coop.ps1 (master plan S1: one implementation,
# in PowerShell); pwsh on macOS/Linux and CI, Windows PowerShell as the fallback.
PWSH="$(command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null || true)"
[ -z "$PWSH" ] && { echo "pwsh (PowerShell 7) required: coop init is dispatched by bin/coop.ps1"; exit 1; }
COOP_PS1="$ROOT/bin/coop.ps1"
if command -v cygpath >/dev/null 2>&1; then COOP_PS1="$(cygpath -w "$COOP_PS1")"; fi

answers() {
  printf '%s\n' "$@"
}

# --- guided wizard generates a usable project.yml -------------------------------
answers \
  "Cooptimize" "Test Client" "" "" "" "" "" "n" "no" "no" "n" | \
  HOME="$TMP" "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "wizard exits 0" || ko "wizard exit: $rc"
[ -f "$TMP/repo/.coop/project.yml" ] && ok "project.yml created" || ko "project.yml missing"

# --- yaml contains discovered/prefilled values ----------------------------------
text="$(cat "$TMP/repo/.coop/project.yml")"
case "$text" in *"organization: 'Cooptimize'"*) ok "organization written" ;; *) ko "organization missing" ;; esac
case "$text" in *"client: 'Test Client'"*) ok "client written" ;; *) ko "client missing" ;; esac
case "$text" in *"enabled: false"*) ok "Fabric disabled when declined" ;; *) ko "Fabric should be disabled" ;; esac
case "$text" in *"coop_data_doc:"*) ok "data_doc tool written" ;; *) ko "data_doc missing" ;; esac
if grep -q '^standards:' "$TMP/repo/.coop/project.yml"; then ko "guided wizard wrote default standards overrides"; else ok "guided wizard omits default standards overrides"; fi
case "$text" in *"#   sql:"*"#     path: "*) ok "guided wizard documents the nested standards override shape" ;; *) ko "standards override comment missing" ;; esac

# --- Fabric setup signs in inline and detects the tenant ----------------------
az_login_stub="$TMP/az-login-stub"
cat > "$az_login_stub" <<'SH'
#!/bin/sh
state="${COOP_TEST_AZ_STATE:?}"
if [ "$1" = "login" ]; then
  touch "$state"
  printf '%s\n' '[{"tenantId":"tenant-from-login"}]'
  exit 0
fi
exit 1
SH
chmod +x "$az_login_stub"
az_login_state="$TMP/az-signed-in"
if command -v cygpath >/dev/null 2>&1; then
  az_login_stub_bat="$TMP/az-login-stub.bat"
  printf '%s\r\n' \
    '@echo off' \
    'if "%1"=="login" (type nul > "%COOP_TEST_AZ_STATE%" & echo [{"tenantId":"tenant-from-login"}] & exit /b 0)' \
    'exit /b 1' > "$az_login_stub_bat"
  az_login_stub="$(cygpath -w "$az_login_stub_bat")"
  az_login_state="$(cygpath -w "$az_login_state")"
fi
answers \
  "Cooptimize" "Login Client" "" "" "" "" "" "generic" "n" "y" "y" "" "n" "n" | \
  COOP_AZ_BIN="$az_login_stub" COOP_TEST_AZ_STATE="$az_login_state" \
  HOME="$TMP" "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo-login" > "$TMP/login.out" 2>&1
login_text="$(cat "$TMP/repo-login/.coop/project.yml" 2>/dev/null)"
case "$(cat "$TMP/login.out")" in
  *"Sign in now so Coop can detect the client tenant automatically?"*) ok "Fabric setup offers inline Azure sign-in" ;;
  *) ko "Fabric setup did not offer inline Azure sign-in" ;;
esac
case "$login_text" in
  *"tenant_id: 'tenant-from-login'"*)
    case "$(cat "$TMP/login.out")" in
      *"Signed in. Detected client tenant"*) ok "Azure login JSON tenant written and visibly confirmed" ;;
      *) ko "Azure login tenant was not visibly confirmed" ;;
    esac ;;
  *) ko "Azure login tenant was not detected" ;;
esac

# --- legacy --template still works --------------------------------------------
mkdir -p "$TMP/legacy"
HOME="$TMP" USERPROFILE="$TMP" "$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$COOP_PS1" init --template "$TMP/legacy" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "--template exits 0" || ko "--template exit: $rc"
[ -s "$TMP/legacy/.coop/project.yml" ] && ok "--template produced output" || ko "--template output empty"
if grep -q '^standards:' "$TMP/legacy/.coop/project.yml"; then ko "template wrote default standards overrides"; else ok "template omits default standards overrides"; fi

# --- lineage-docs offer: accepting runs coop-data-doc setup -------------------
mkdir -p "$TMP/stubbin"
cat > "$TMP/stubbin/coop-data-doc" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$COOP_SETUP_MARKER.calls"
if [ "$1" = "config-set" ]; then cat > "$COOP_SETUP_MARKER.patch"; fi
exit 0
EOF
chmod +x "$TMP/stubbin/coop-data-doc"

# Windows Python subprocess resolves by extension; provide a .bat twin that
# mirrors the sh stub (records invocations; captures config-set stdin patch).
# Use CRLF so cmd.exe parses the batch file reliably on Windows runners.
printf '@echo off\r\necho %%* >> "%%COOP_SETUP_MARKER%%.calls"\r\nif "%%1"=="config-set" findstr . > "%%COOP_SETUP_MARKER%%.patch"\r\nexit /b 0\r\n' > "$TMP/stubbin/coop-data-doc.bat"

# init_wizard.py honors COOP_DATA_DOC_BIN so tests can point it at the stub
# without relying on PATH/extension resolution across Linux/Git-Bash/Windows.
if command -v cygpath >/dev/null 2>&1; then
  COOP_DATA_DOC_BIN="$(cygpath -w "$TMP/stubbin/coop-data-doc.bat")"
else
  COOP_DATA_DOC_BIN="$TMP/stubbin/coop-data-doc"
fi
export COOP_DATA_DOC_BIN

# Explicit SQL role guarantees config-set seeding before native setup.
answers "Cooptimize" "Test Client" "" "" "" "" "" "sql" "n" "no" "no" "y" | \
  COOP_SETUP_MARKER=setup-marker \
  COOP_DATA_DOC_BIN="$COOP_DATA_DOC_BIN" \
  HOME="$TMP" \
  "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo2" > "$TMP/accepted.out" 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "wizard exits 0 with lineage offer accepted" || ko "wizard exit: $rc"
[ -f "$TMP/repo2/.coop/project.yml" ] && ok "project.yml created (lineage path)" || ko "project.yml missing (lineage path)"
case "$(cat "$TMP/repo2/setup-marker.calls" 2>/dev/null)" in *"config-set"*"setup"*) ok "config-set ran before native setup" ;; *) ko "lineage invocation order incorrect" ;; esac
"$PY" - "$TMP/repo2/setup-marker.patch" "$TMP/repo2" <<'PY'
import json,sys
from pathlib import Path
p=json.load(open(sys.argv[1])); assert Path(p['repos']['sql']['path']).resolve()==Path(sys.argv[2]).resolve()
PY
[ "$?" -eq 0 ] && ok "seed patch contains the entered SQL path" || ko "seed patch missing entered path"

# --- lineage offer declined → no coop-data-doc invocation ----------------------
answers "Cooptimize" "Test Client" "" "" "" "" "" "generic" "n" "no" "no" "n" | \
  COOP_SETUP_MARKER=setup-marker2 \
  COOP_DATA_DOC_BIN="$COOP_DATA_DOC_BIN" \
  HOME="$TMP" \
  "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo3" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "wizard exits 0 with lineage offer declined" || ko "wizard exit: $rc"
[ ! -f "$TMP/repo3/setup-marker2.calls" ] && ok "coop-data-doc setup NOT invoked when declined" || ko "coop-data-doc setup invoked despite decline"

# --- C1: one contract per client Git root; nothing is created below it ----------
mkdir -p "$TMP/client/.coop" "$TMP/client/analytics/.git" "$TMP/client/reports/.git"
printf "profile:\n  client: 'Contoso'\n" > "$TMP/client/.coop/project.yml"
answers "Cooptimize" "Test Client" "" "" "" "" "" "n" "no" "no" "n" | \
  HOME="$TMP" "$PY" "$ROOT/lib/init_wizard.py" "$TMP/client/analytics" >"$TMP/below.out" 2>&1
rc=$?
[ "$rc" -ne 0 ] && ok "python wizard refuses a contract below an existing one (exit $rc)" || ko "python wizard created a second contract below the root"
[ ! -e "$TMP/client/analytics/.coop" ] && ok "no .coop was created below the root contract" || ko "a second .coop appeared below the root contract"
grep -q "a contract already covers this folder" "$TMP/below.out" && ok "the refusal names the covering contract" || ko "refusal message missing: $(cat "$TMP/below.out")"
HOME="$TMP" USERPROFILE="$TMP" "$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$COOP_PS1" init "$TMP/client/reports" >"$TMP/below-ps.out" 2>&1 </dev/null
rc=$?
[ "$rc" -ne 0 ] && ok "coop init refuses a contract below an existing one (exit $rc)" || ko "coop init created a second contract below the root"
[ ! -e "$TMP/client/reports/.coop" ] && ok "coop init wrote nothing below the root contract" || ko "coop init wrote a second .coop below the root"
grep -q "a contract already covers this folder" "$TMP/below-ps.out" && ok "coop init names the covering contract" || ko "coop init refusal message missing: $(cat "$TMP/below-ps.out")"
case "$(cat "$TMP/repo/.coop/project.yml")" in *"# One committed team file per client"*) ok "the generated header says the contract is the committed team file" ;; *) ko "generated header lacks the committed-team-file line" ;; esac

# --- C1: beside several repositories, coop init creates the client home repository
if command -v git >/dev/null 2>&1; then
  mkdir -p "$TMP/estate/analytics" "$TMP/estate/reports"
  git -C "$TMP/estate/analytics" init --quiet
  git -C "$TMP/estate/reports" init --quiet
  answers "" "" "" "" "" "" "" "n" "no" "no" "n" | HOME="$TMP" USERPROFILE="$TMP" COOP_ASSUME_YES=1 COOP_INIT_CLIENT="Fabrikam Foods" \
    "$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$COOP_PS1" init "$TMP/estate/analytics" >"$TMP/home.out" 2>&1
  rc=$?
  [ "$rc" -eq 0 ] && ok "coop init exits 0 beside several repositories (home repo)" || ko "coop init home-repo exit $rc: $(cat "$TMP/home.out")"
  [ -f "$TMP/estate/fabrikam-foods-coop/.coop/project.yml" ] && ok "the project file went into the client home repository <client>-coop" || ko "no project file in the home repository: $(cat "$TMP/home.out")"
  [ -d "$TMP/estate/fabrikam-foods-coop/.git" ] && ok "the home repository was git-initialised" || ko "home repository has no .git"
  grep -q "Fabrikam Foods" "$TMP/estate/fabrikam-foods-coop/README.md" 2>/dev/null && ok "the home repository README names the client" || ko "home README missing or unnamed"
  home_text="$(cat "$TMP/estate/fabrikam-foods-coop/.coop/project.yml")"
  case "$home_text" in *"client: 'Fabrikam Foods'"*"  'analytics':"*"local_path: '../analytics'"*"  'reports':"*"local_path: '../reports'"*) ok "the home repository's contract lists both repositories as ../<name>" ;; *) ko "sibling repositories not listed: $home_text" ;; esac
  [ ! -e "$TMP/estate/analytics/.coop" ] && [ ! -e "$TMP/estate/.coop" ] && ok "nothing was written in the repository or the parent folder" || ko "a contract appeared outside the home repository"
  grep -q "Not shared yet" "$TMP/home.out" && ok "without an origin, coop init says the file is not shared yet" || ko "missing 'Not shared yet' line: $(cat "$TMP/home.out")"
  HOME="$TMP" USERPROFILE="$TMP" "$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$COOP_PS1" init "$TMP/estate/reports" >"$TMP/home2.out" 2>&1 </dev/null
  rc=$?
  [ "$rc" -ne 0 ] && grep -q "One project file per client" "$TMP/home2.out" && ok "a sibling repository finds the home repository's contract and refuses a second one" || ko "sibling lookup failed (exit $rc): $(cat "$TMP/home2.out")"
else
  echo "  SKIP home-repository cases: git not installed"
fi

# Tabular Editor CLI captures both executable and BPA rules path.
answers "Cooptimize" "BPA Client" "" "" "" "" "" "generic" "n" "no" "yes" "/custom/te" "/rules/BPARules.json" "n" | \
  HOME="$TMP" "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo4" >/dev/null 2>&1
text="$(cat "$TMP/repo4/.coop/project.yml")"
case "$text" in *"executable_path: '/custom/te'"*"bpa_rules_path: '/rules/BPARules.json'"*) ok "Tabular Editor executable and BPA rules captured" ;; *) ko "Tabular Editor config incomplete" ;; esac

exit $fail
