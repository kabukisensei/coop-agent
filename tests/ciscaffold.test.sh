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
# The data-docs job (the only gate since ST1) needs the repo's coop-data-doc.yml.
printf 'version: 1\n' > "$TMP/proj/coop-data-doc.yml"
cd "$TMP/proj"

# 1. GitHub Actions generation
"$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for github"

gh_file="$TMP/proj/.github/workflows/coop-gates.yml"
[ -f "$gh_file" ] || fail "GitHub pipeline not generated"
grep -q "coop-data-doc check" "$gh_file" || fail "lineage-docs gate not in GitHub pipeline"
grep -q "sql-review\|dax-review" "$gh_file" && fail "retired review jobs still in GitHub pipeline (ST1)"
grep -q "TODO" "$gh_file" && fail "TODO path included in GitHub pipeline"
pass "GitHub Actions CI generated correctly"

# 2. ADO generation
"$PY" "$ROOT/lib/_ciscaffold.py" ado "$TMP/proj/.coop/project.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for ado"

ado_file="$TMP/proj/azure-pipelines/coop-gates.yml"
[ -f "$ado_file" ] || fail "ADO pipeline not generated"
grep -q "coop-data-doc check" "$ado_file" || fail "lineage-docs gate not in ADO pipeline"
grep -q "sql_review\|dax_review" "$ado_file" && fail "retired review jobs still in ADO pipeline (ST1)"
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
  || fail "numeric sql_root should still parse as a real value"
pass "contract with a numeric sql_root is accepted"

# 4. YAML list top-level should fail cleanly, not AttributeError.
cat > "$TMP/proj/.coop/project-list.yml" <<PROJ
- a
- b
PROJ
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project-list.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null 2>&1; then
  fail "top-level YAML list should be rejected"
fi
pass "top-level YAML list rejected cleanly"

# 5. Without a coop-data-doc.yml there is nothing to generate (exit 3, no file).
mkdir -p "$TMP/empty/.coop" && cp "$TMP/proj/.coop/project.yml" "$TMP/empty/.coop/project.yml"
( cd "$TMP/empty" && "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/empty/.coop/project.yml" "$ROOT/config/release-manifest.json" "$TMP/empty" > /dev/null 2>&1 )
[ $? -eq 3 ] || fail "missing coop-data-doc.yml should exit 3"
[ -f "$TMP/empty/.github/workflows/coop-gates.yml" ] && fail "no pipeline should be written without coop-data-doc.yml"
pass "no coop-data-doc.yml exits 3 without writing"

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
{"python_tools": {"coop-data-doc": "0.33.0; rm -rf /"}}
DEF
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project-ver.yml" "$TMP/manifest-bad.json" "$TMP/proj" > /dev/null 2>&1; then
  fail "version with shell metacharacters should be rejected"
fi
pass "version injection rejected"

# 7. The generated pipelines pin exactly the manifest's coop-tool versions.
"$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$ROOT/config/release-manifest.json" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed against the real manifest"
for tool in coop-data-doc; do
  pin="$(sed -n 's/^[[:space:]]*"'"$tool"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/config/release-manifest.json")"
  grep -q "pipx install $tool==$pin" "$gh_file" || fail "GitHub pipeline must pin $tool==$pin (the manifest's python_tools)"
done
pass "pipelines pin the manifest's coop-tool versions"

printf '  %s\n' "ciscaffold tests passed"
