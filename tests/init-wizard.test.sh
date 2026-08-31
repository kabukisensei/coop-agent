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

# --- Fabric setup signs in inline and detects the tenant ----------------------
az_login_stub="$TMP/az-login-stub"
cat > "$az_login_stub" <<'SH'
#!/bin/sh
state="${COOP_TEST_AZ_STATE:?}"
if [ "$1" = "login" ]; then touch "$state"; exit 0; fi
if [ "$1 $2" = "account show" ] && [ -f "$state" ]; then
  printf '%s\n' '{"tenantId":"tenant-from-login"}'
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
    'if "%1"=="login" (type nul > "%COOP_TEST_AZ_STATE%" & exit /b 0)' \
    'if "%1"=="account" if "%2"=="show" if exist "%COOP_TEST_AZ_STATE%" (echo {"tenantId":"tenant-from-login"} & exit /b 0)' \
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
  *"tenant_id: 'tenant-from-login'"*) ok "Azure login tenant written to project contract" ;;
  *) ko "Azure login tenant was not detected" ;;
esac

# --- legacy --template still works --------------------------------------------
mkdir -p "$TMP/legacy"
HOME="$TMP" bash "$ROOT/bin/coop" init --template "$TMP/legacy" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "--template exits 0" || ko "--template exit: $rc"
[ -s "$TMP/legacy/.coop/project.yml" ] && ok "--template produced output" || ko "--template output empty"

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

# Tabular Editor CLI captures both executable and BPA rules path.
answers "Cooptimize" "BPA Client" "" "" "" "" "" "generic" "n" "no" "yes" "/custom/te" "/rules/BPARules.json" "n" | \
  HOME="$TMP" "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo4" >/dev/null 2>&1
text="$(cat "$TMP/repo4/.coop/project.yml")"
case "$text" in *"executable_path: '/custom/te'"*"bpa_rules_path: '/rules/BPARules.json'"*) ok "Tabular Editor executable and BPA rules captured" ;; *) ko "Tabular Editor config incomplete" ;; esac

exit $fail
