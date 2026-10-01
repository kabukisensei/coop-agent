#!/usr/bin/env bash
#
# coop init --ci (issue #39): lib/_ciscaffold.py tests
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

PY="$(command -v python3 || command -v python)" || fail "python required for this test"

mkdir -p "$TMP/proj/.coop"
cat > "$TMP/proj/.coop/project.yml" <<PROJ
repositories:
  fabric_dw:
    local_path: "sqlrepo"
    sql_root: "sql"
power_bi:
  semantic_models:
    - path: "pbirepo/model1"
    - path: "TODO: fixme"
PROJ

# 1. GitHub Actions generation
"$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for github"

gh_file="$TMP/proj/.github/workflows/coop-gates.yml"
[ -f "$gh_file" ] || fail "GitHub pipeline not generated"
grep -q "sqlrepo/sql" "$gh_file" || fail "SQL path not in GitHub pipeline"
grep -q "pbirepo/model1" "$gh_file" || fail "Power BI path not in GitHub pipeline"
grep -q "TODO" "$gh_file" && fail "TODO path included in GitHub pipeline"
pass "GitHub Actions CI generated correctly"

# 2. ADO generation
"$PY" "$ROOT/lib/_ciscaffold.py" ado "$TMP/proj/.coop/project.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for ado"

ado_file="$TMP/proj/azure-pipelines/coop-gates.yml"
[ -f "$ado_file" ] || fail "ADO pipeline not generated"
grep -q "sqlrepo/sql" "$ado_file" || fail "SQL path not in ADO pipeline"
grep -q "pbirepo/model1" "$ado_file" || fail "Power BI path not in ADO pipeline"
grep -q "TODO" "$ado_file" && fail "TODO path included in ADO pipeline"
pass "Azure DevOps CI generated correctly"

# 3. is_todo no longer treats 0 / [] / False as TODO — numeric sql_root is used.
cat > "$TMP/proj/.coop/project-numeric.yml" <<PROJ
repositories:
  dw:
    local_path: "sqlrepo"
    sql_root: 0
power_bi:
  semantic_models: []
PROJ
"$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project-numeric.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null \
  || fail "numeric sql_root should be treated as a real value"
grep -q "sqlrepo/0" "$gh_file" || fail "numeric sql_root should produce sqlrepo/0 path"
pass "is_todo does not treat 0 as TODO"

# 4. YAML list top-level should fail cleanly, not AttributeError.
cat > "$TMP/proj/.coop/project-list.yml" <<PROJ
- a
- b
PROJ
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project-list.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null 2>&1; then
  fail "top-level YAML list should be rejected"
fi
pass "top-level YAML list rejected cleanly"

# 5. Path injection should be rejected.
cat > "$TMP/proj/.coop/project-inject.yml" <<PROJ
repositories:
  dw:
    local_path: "sqlrepo; rm -rf /"
    sql_root: "sql"
power_bi:
  semantic_models: []
PROJ
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project-inject.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null 2>&1; then
  fail "path with shell metacharacters should be rejected"
fi
pass "path injection rejected"

# 6. Version injection should be rejected (the pins come from the release manifest).
cat > "$TMP/proj/.coop/project-ver.yml" <<PROJ
repositories:
  dw:
    local_path: "sqlrepo"
    sql_root: "sql"
power_bi:
  semantic_models: []
PROJ
cat > "$TMP/manifest-bad.json" <<DEF
{"python_tools": {"coop-sql-review": "0.12.0; rm -rf /", "coop-dax-review": "0.15.0", "coop-data-doc": "0.33.0"}}
DEF
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project-ver.yml" "$TMP/manifest-bad.json" "$TMP/proj" > /dev/null 2>&1; then
  fail "version with shell metacharacters should be rejected"
fi
pass "version injection rejected"

# 7. The generated pipelines pin exactly the manifest's coop-tool versions.
"$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed against the real manifest"
for tool in coop-sql-review coop-dax-review; do   # the data-docs job needs a coop-data-doc.yml in the cwd
  pin="$(sed -n 's/^[[:space:]]*"'"$tool"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/config/release-manifest.json")"
  grep -q "pipx install $tool==$pin" "$gh_file" || fail "GitHub pipeline must pin $tool==$pin (the manifest's python_tools)"
done
pass "pipelines pin the manifest's coop-tool versions"

printf '  %s\n' "ciscaffold tests passed"
