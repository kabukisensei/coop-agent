#!/usr/bin/env bash
#
# coop init --ci (issue #39): lib/_ciscaffold.py tests. Since ST1 the only gate it
# generates is the coop-data-doc lineage-docs job (the coop-sql-review /
# coop-dax-review jobs retired with the CLIs).
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
PROJ

# 1. No coop-data-doc.yml -> nothing to generate (exit 3), no file written.
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$ROOT/config/defaults.yml" "$TMP/proj" > /dev/null 2>&1; then
  fail "_ciscaffold.py should exit 3 without coop-data-doc.yml"
fi
[ ! -e "$TMP/proj/.github/workflows/coop-gates.yml" ] || fail "no pipeline may be written without coop-data-doc.yml"
pass "no coop-data-doc.yml -> no CI gates (exit 3)"

echo 'project_name: test' > "$TMP/proj/coop-data-doc.yml"

# 2. GitHub Actions generation: only the lineage-docs job, pinned to tested_with.
"$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$ROOT/config/defaults.yml" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for github"
gh_file="$TMP/proj/.github/workflows/coop-gates.yml"
[ -f "$gh_file" ] || fail "GitHub pipeline not generated"
grep -q "coop-data-doc check" "$gh_file" || fail "docs freshness gate missing from GitHub pipeline"
grep -q "pipx install coop-data-doc==" "$gh_file" || fail "coop-data-doc pin missing from GitHub pipeline"
grep -q "sql-review\|dax-review\|security-events" "$gh_file" && fail "retired reviewer jobs must not be generated"
pass "GitHub Actions CI generated correctly (lineage docs only)"

# 3. ADO generation
"$PY" "$ROOT/lib/_ciscaffold.py" ado "$TMP/proj/.coop/project.yml" "$ROOT/config/defaults.yml" "$TMP/proj" > /dev/null \
  || fail "_ciscaffold.py should succeed for ado"
ado_file="$TMP/proj/azure-pipelines/coop-gates.yml"
[ -f "$ado_file" ] || fail "ADO pipeline not generated"
grep -q "coop-data-doc check" "$ado_file" || fail "docs freshness gate missing from ADO pipeline"
grep -q "sql-review\|dax-review" "$ado_file" && fail "retired reviewer jobs must not be generated"
pass "Azure DevOps CI generated correctly (lineage docs only)"

# 4. YAML list top-level should fail cleanly, not AttributeError.
cat > "$TMP/proj/.coop/project-list.yml" <<PROJ
- a
- b
PROJ
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project-list.yml" "$ROOT/config/defaults.yml" "$TMP/proj" > /dev/null 2>&1; then
  fail "top-level YAML list should be rejected"
fi
pass "top-level YAML list rejected cleanly"

# 5. Version injection should be rejected.
cat > "$TMP/defaults-bad.yml" <<DEF
tested_with:
  coop_data_doc: "0.33.0; rm -rf /"
DEF
if "$PY" "$ROOT/lib/_ciscaffold.py" github "$TMP/proj/.coop/project.yml" "$TMP/defaults-bad.yml" "$TMP/proj" > /dev/null 2>&1; then
  fail "version with shell metacharacters should be rejected"
fi
pass "version injection rejected"

printf '  %s\n' "ciscaffold tests passed"
