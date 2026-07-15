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
"$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$ROOT/config/defaults.yml" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for github"

gh_file="$TMP/proj/.github/workflows/coop-gates.yml"
[ -f "$gh_file" ] || fail "GitHub pipeline not generated"
grep -q "sqlrepo/sql" "$gh_file" || fail "SQL path not in GitHub pipeline"
grep -q "pbirepo/model1" "$gh_file" || fail "Power BI path not in GitHub pipeline"
grep -q "TODO" "$gh_file" && fail "TODO path included in GitHub pipeline"
pass "GitHub Actions CI generated correctly"

# 2. ADO generation
"$PY" "$ROOT/lib/_ciscaffold.py" ado "$TMP/proj/.coop/project.yml" "$ROOT/config/defaults.yml" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for ado"

ado_file="$TMP/proj/azure-pipelines/coop-gates.yml"
[ -f "$ado_file" ] || fail "ADO pipeline not generated"
grep -q "sqlrepo/sql" "$ado_file" || fail "SQL path not in ADO pipeline"
grep -q "pbirepo/model1" "$ado_file" || fail "Power BI path not in ADO pipeline"
grep -q "TODO" "$ado_file" && fail "TODO path included in ADO pipeline"
pass "Azure DevOps CI generated correctly"

printf '  %s\n' "ciscaffold tests passed"
