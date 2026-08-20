#!/usr/bin/env bash
#
# BPA runner regression test: lib/_bpa_runner.py drives the cross-platform `te`
# CLI via `te bpa run <model> -r <rules> --non-interactive` and must NEVER
# resolve or invoke the legacy Tabular Editor 2 executable (fixed 2026-08-20).
#
# Windows notes (CI runs this under Git Bash): shutil.which() on Windows only
# sees PATHEXT extensions, so the fake ships as `te` (unix) AND `te.cmd`
# (Windows, CRLF); and Git Bash PATH entries use /tmp/... paths that native
# Windows processes can't search, so the bin dir is converted with cygpath.
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

# project.yml enabling BPA with a rules file (absolute paths so the runner's
# base-dir join can't mis-resolve them in the temp dir)
cat > "$TMP/project.yml" <<YAML
tools:
  tabular_editor_cli:
    enabled: "true"
    bpa_rules_path: $TMP/rules.json
power_bi:
  semantic_models:
    - path: model.bim
YAML
touch "$TMP/model.bim" "$TMP/rules.json"

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

# Git Bash PATH entries must be native Windows paths for the python child.
_bindir="$TMP/bin"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) _bindir="$(cygpath -w "$_bindir" 2>/dev/null || echo "$_bindir")" ;;
esac

PATH="$_bindir:$PATH" "$_py" "$ROOT/lib/_bpa_runner.py" "$TMP/project.yml" "$TMP/out.json" "$TMP/model.bim" 2>"$TMP/err"
rc=$?
[ "$rc" -eq 0 ] || { echo "FAIL: runner exited $rc"; cat "$TMP/err"; exit 1; }
grep -q 'TE2 WAS INVOKED' "$TMP/err" && { echo "FAIL: TabularEditor.exe was invoked — runner must use te only"; exit 1; }
[ -f "$TMP/out.json" ] || { echo "FAIL: no report written"; cat "$TMP/err"; exit 1; }

"$_py" - <<PYEOF
import json
d = json.load(open("$TMP/out.json"))
assert d["summary"]["info"] == 1, d
assert d["findings"][0]["rule"] == "Unneeded columns in tables", d
assert d["findings"][0]["object"] == "Revenue", d
PYEOF
[ $? -eq 0 ] || { echo "FAIL: findings not parsed as expected"; exit 1; }

echo "PASS: BPA runner invoked te with bpa run --non-interactive, never touched TE2, and parsed JSON findings"
