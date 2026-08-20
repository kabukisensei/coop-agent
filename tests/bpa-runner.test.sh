#!/usr/bin/env bash
#
# BPA runner regression test: lib/_bpa_runner.py drives the cross-platform `te`
# CLI via `te bpa run <model> -r <rules> --non-interactive` and must NEVER
# resolve or invoke the legacy Tabular Editor 2 executable (fixed 2026-08-20).
#
# Windows notes (CI runs this under Git Bash): every path the native python
# child sees is converted explicitly with cygpath -m (never rely on MSYS
# argument/PATH conversion), and the fake is pinned via
# tools.tabular_editor_cli.executable_path (a te.cmd fake) — Git Bash PATH
# semantics are unreliable for native children. On unix the extensionless
# `te` fake exercises shutil.which() resolution through PATH.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

_py="$(command -v python3 || command -v python || true)"
if [ -z "$_py" ] || ! "$_py" -c 'import json' >/dev/null 2>&1; then
  # No python, or a Windows Store stub (which finds as python3 but won't run).
  echo "SKIP: no usable python available"; exit 0
fi

_iswin=0
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) _iswin=1 ;; esac
if [ "$_iswin" = 1 ]; then
  # Mixed (forward-slash) form: valid for Windows python open()/subprocess and
  # for Git Bash's [ -f ] checks against the same temp dir.
  _tmp_native="$(cygpath -m "$TMP" 2>/dev/null || echo "$TMP")"
  _root_native="$(cygpath -m "$ROOT" 2>/dev/null || echo "$ROOT")"
else
  _tmp_native="$TMP"
  _root_native="$ROOT"
fi

mkdir -p "$TMP/bin"
# Fake `te` (unix) that validates the bpa-run invocation shape and emits one JSON finding.
cat > "$TMP/bin/te" <<'EOF'
#!/usr/bin/env bash
if [ "$1" != "bpa" ] || [ "$2" != "run" ]; then echo "BAD SUBCOMMAND: $*" >&2; exit 9; fi
case " $* " in
  *" -r "*) : ;;
  *) echo "MISSING -r: $*" >&2; exit 9 ;;
esac
case " $* " in
  *" --non-interactive "*) : ;;
  *) echo "MISSING --non-interactive: $*" >&2; exit 9 ;;
esac
echo '{"findings":[{"ruleId":"Unneeded columns in tables","severity":"info","object":"Revenue","message":"fake finding"}]}'
exit 0
EOF
# Fake `te.cmd` (Windows): same contract, CRLF line endings for cmd.exe.
cat > "$TMP/bin/te.cmd" <<'EOF'
@echo off
if not "%1"=="bpa" (echo BAD SUBCOMMAND: %* 1>&2 & exit /b 9)
if not "%2"=="run" (echo BAD SUBCOMMAND: %* 1>&2 & exit /b 9)
echo %* | findstr /c:"-r" >nul || (echo MISSING -r: %* 1>&2 & exit /b 9)
echo %* | findstr /c:"--non-interactive" >nul || (echo MISSING --non-interactive: %* 1>&2 & exit /b 9)
echo {"findings":[{"ruleId":"Unneeded columns in tables","severity":"info","object":"Revenue","message":"fake finding"}]}
exit /b 0
EOF
sed -i.bak 's/$/\r/' "$TMP/bin/te.cmd" && rm -f "$TMP/bin/te.cmd.bak"
# A legacy TE2 executable must never be touched.
cat > "$TMP/bin/TabularEditor.exe" <<'EOF'
#!/usr/bin/env bash
echo "TE2 WAS INVOKED" >&2
exit 42
EOF
chmod +x "$TMP/bin/te" "$TMP/bin/TabularEditor.exe" 2>/dev/null || true
touch "$TMP/model.bim" "$TMP/rules.json"

# project.yml with native paths. On Windows, pin executable_path so the run
# does not depend on PATH resolution of the fake under Git Bash (real users
# have te.exe on PATH; shutil.which is still exercised on unix).
if [ "$_iswin" = 1 ]; then
  cat > "$TMP/project.yml" <<YAML
tools:
  tabular_editor_cli:
    enabled: "true"
    executable_path: $_tmp_native/bin/te.cmd
    bpa_rules_path: $_tmp_native/rules.json
power_bi:
  semantic_models:
    - path: model.bim
YAML
else
  cat > "$TMP/project.yml" <<YAML
tools:
  tabular_editor_cli:
    enabled: "true"
    bpa_rules_path: $_tmp_native/rules.json
power_bi:
  semantic_models:
    - path: model.bim
YAML
fi

if [ "$_iswin" = 0 ]; then
  PATH="$TMP/bin:$PATH" "$_py" "$_root_native/lib/_bpa_runner.py" "$_tmp_native/project.yml" "$_tmp_native/out.json" "$_tmp_native/model.bim" 2>"$TMP/err"
else
  "$_py" "$_root_native/lib/_bpa_runner.py" "$_tmp_native/project.yml" "$_tmp_native/out.json" "$_tmp_native/model.bim" 2>"$TMP/err"
fi
rc=$?
[ "$rc" -eq 0 ] || { echo "FAIL: runner exited $rc"; cat "$TMP/err"; exit 1; }
grep -q 'TE2 WAS INVOKED' "$TMP/err" && { echo "FAIL: TabularEditor.exe was invoked — runner must use te only"; exit 1; }
[ -f "$TMP/out.json" ] || { echo "FAIL: no report written"; cat "$TMP/err"; exit 1; }

"$_py" - <<PYEOF
import json
d = json.load(open("$_tmp_native/out.json"))
assert d["summary"]["info"] == 1, d
assert d["findings"][0]["rule"] == "Unneeded columns in tables", d
assert d["findings"][0]["object"] == "Revenue", d
PYEOF
[ $? -eq 0 ] || { echo "FAIL: findings not parsed as expected"; exit 1; }

echo "PASS: BPA runner invoked te with bpa run --non-interactive, never touched TE2, and parsed JSON findings"
