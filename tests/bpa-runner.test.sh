#!/usr/bin/env bash
#
# BPA runner regression test: lib/_bpa_runner.py drives the cross-platform `te`
# CLI via `te bpa run <model> -r <rules> --non-interactive` and must NEVER
# resolve or invoke the legacy Tabular Editor 2 executable (fixed 2026-08-20).
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

_py="$(command -v python3 || command -v python || true)"
if [ -z "$_py" ]; then echo "SKIP: python not available"; exit 0; fi

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
# Fake `te` that validates the bpa-run invocation shape and emits one JSON finding.
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
# A legacy TE2 executable must never be touched.
cat > "$TMP/bin/TabularEditor.exe" <<'EOF'
#!/usr/bin/env bash
echo "TE2 WAS INVOKED" >&2
exit 42
EOF
chmod +x "$TMP/bin/te" "$TMP/bin/TabularEditor.exe"

PATH="$TMP/bin:$PATH" "$_py" "$ROOT/lib/_bpa_runner.py" "$TMP/project.yml" "$TMP/out.json" "$TMP/model.bim" 2>"$TMP/err"
rc=$?
[ "$rc" -eq 0 ] || { echo "FAIL: runner exited $rc"; cat "$TMP/err"; exit 1; }
grep -q 'TE2 WAS INVOKED' "$TMP/err" && { echo "FAIL: TabularEditor.exe was invoked — runner must use te only"; exit 1; }
[ -f "$TMP/out.json" ] || { echo "FAIL: no report written"; exit 1; }

"$_py" - <<PYEOF
import json
d = json.load(open("$TMP/out.json"))
assert d["summary"]["info"] == 1, d
assert d["findings"][0]["rule"] == "Unneeded columns in tables", d
assert d["findings"][0]["object"] == "Revenue", d
PYEOF
[ $? -eq 0 ] || { echo "FAIL: findings not parsed as expected"; exit 1; }

echo "PASS: BPA runner invoked te with bpa run --non-interactive, never touched TE2, and parsed JSON findings"
