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
  "Cooptimize" "Test Client" "" "" "" "" "" "no" | \
  HOME="$TMP" "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "wizard exits 0" || ko "wizard exit: $rc"
[ -f "$TMP/repo/.coop/project.yml" ] && ok "project.yml created" || ko "project.yml missing"

# --- yaml contains discovered/prefilled values ----------------------------------
text="$(cat "$TMP/repo/.coop/project.yml")"
case "$text" in *"organization: Cooptimize"*) ok "organization written" ;; *) ko "organization missing" ;; esac
case "$text" in *"client: \"Test Client\""*) ok "client written" ;; *) ko "client missing" ;; esac
case "$text" in *"enabled: false"*) ok "Fabric disabled when declined" ;; *) ko "Fabric should be disabled" ;; esac
case "$text" in *"coop_data_doc:"*) ok "data_doc tool written" ;; *) ko "data_doc missing" ;; esac

# --- legacy --template still works --------------------------------------------
mkdir -p "$TMP/legacy/.coop"
HOME="$TMP" "$PY" "$ROOT/lib/init_wizard.py" "$TMP/legacy" --template > "$TMP/legacy/.coop/project.yml" 2>/dev/null
rc=$?
[ "$rc" -eq 0 ] && ok "--template exits 0" || ko "--template exit: $rc"
[ -s "$TMP/legacy/.coop/project.yml" ] && ok "--template produced output" || ko "--template output empty"

# --- lineage-docs offer: accepting runs coop-data-doc setup -------------------
mkdir -p "$TMP/stubbin"
cat > "$TMP/stubbin/coop-data-doc" <<'EOF'
#!/bin/sh
printf 'stub coop-data-doc invoked: %s\n' "$*" > "$COOP_SETUP_MARKER"
exit 0
EOF
chmod +x "$TMP/stubbin/coop-data-doc"

# Windows Python subprocess resolves by extension; provide a .bat twin.
# Use CRLF so cmd.exe parses the batch file reliably on Windows runners.
printf '@echo off\r\ntype nul > "%%COOP_SETUP_MARKER%%"\r\nexit /b 0\r\n' > "$TMP/stubbin/coop-data-doc.bat"

# init_wizard.py honors COOP_DATA_DOC_BIN so tests can point it at the stub
# without relying on PATH/extension resolution across Linux/Git-Bash/Windows.
if command -v cygpath >/dev/null 2>&1; then
  COOP_DATA_DOC_BIN="$(cygpath -w "$TMP/stubbin/coop-data-doc.bat")"
else
  COOP_DATA_DOC_BIN="$TMP/stubbin/coop-data-doc"
fi
export COOP_DATA_DOC_BIN

# Feed the 8 wizard answers + "y" for the lineage offer (9th prompt).
answers "Cooptimize" "Test Client" "" "" "" "" "" "no" "y" | \
  COOP_SETUP_MARKER=setup-marker \
  COOP_DATA_DOC_BIN="$COOP_DATA_DOC_BIN" \
  HOME="$TMP" \
  "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo2" > "$TMP/accepted.out" 2>&1
rc=$?
echo "DEBUG: COOP_DATA_DOC_BIN=$COOP_DATA_DOC_BIN" >&2
echo "DEBUG: repo2 files:" >&2
ls -la "$TMP/repo2" >&2 || true
echo "DEBUG: accepted.out:" >&2
cat "$TMP/accepted.out" >&2 || true
[ "$rc" -eq 0 ] && ok "wizard exits 0 with lineage offer accepted" || ko "wizard exit: $rc"
[ -f "$TMP/repo2/.coop/project.yml" ] && ok "project.yml created (lineage path)" || ko "project.yml missing (lineage path)"
[ -f "$TMP/repo2/setup-marker" ] && ok "coop-data-doc setup was invoked" || ko "coop-data-doc setup NOT invoked"

# --- lineage offer declined → no coop-data-doc invocation ----------------------
answers "Cooptimize" "Test Client" "" "" "" "" "" "no" "n" | \
  COOP_SETUP_MARKER=setup-marker2 \
  COOP_DATA_DOC_BIN="$COOP_DATA_DOC_BIN" \
  HOME="$TMP" \
  "$PY" "$ROOT/lib/init_wizard.py" "$TMP/repo3" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "wizard exits 0 with lineage offer declined" || ko "wizard exit: $rc"
[ ! -f "$TMP/repo3/setup-marker2" ] && ok "coop-data-doc setup NOT invoked when declined" || ko "coop-data-doc setup invoked despite decline"

exit $fail
