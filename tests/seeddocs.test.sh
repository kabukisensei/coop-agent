#!/usr/bin/env bash
#
# coop init --seed-docs (issue #25): lib/_seeddocs.py classification, then the
# bin/coop.ps1 flow against a shimmed coop-data-doc (tests/fixtures/seeddocs.test.ps1,
# driven through pwsh; master plan S1 retired the bash dispatcher). Fully offline.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

PY="$(command -v python3 || command -v python)" || fail "python required for this test"

# A work repo with a filled contract: one PBI repo, one SQL repo (with sql_root),
# one TODO leftover.
mkdir -p "$TMP/proj/.coop" "$TMP/proj/pbirepo" "$TMP/proj/sqlrepo/sql"
cat > "$TMP/proj/.coop/project.yml" <<EOF
profile:
  organization: "Cooptimize"
repositories:
  fabric:
    description: "Semantic models, reports, and Fabric artifacts"
    local_path: "$TMP/proj/pbirepo"
  fabric_dw:
    description: "Warehouse / Lakehouse SQL"
    local_path: "$TMP/proj/sqlrepo"
    sql_root: "sql"
  extras:
    local_path: "TODO: /path/to/extras"
EOF

# 1. The seeding helper classifies + patches correctly (stdout = pure JSON).
patch="$("$PY" "$ROOT/lib/_seeddocs.py" "$TMP/proj/.coop/project.yml" 2>"$TMP/notes.txt")" || fail "_seeddocs.py should succeed on a filled contract"
"$PY" - "$patch" <<'PYEOF' || fail "patch JSON wrong shape"
import json, sys
p = json.loads(sys.argv[1])
assert set(p) == {"repos"}, p
assert p["repos"]["sql"]["path"].endswith("sqlrepo/sql") or p["repos"]["sql"]["path"].endswith("sqlrepo\\sql"), p
assert p["repos"]["powerbi"]["path"].endswith("pbirepo"), p
PYEOF
grep -q "extras.local_path is a TODO placeholder" "$TMP/notes.txt" || fail "TODO repo should be noted on stderr"
pass "_seeddocs.py maps sql (incl. sql_root) + powerbi, skips the TODO repo"

# A monorepo explicitly marked mixed feeds both conventional slots.
mkdir -p "$TMP/mixed/.coop" "$TMP/mixed/source/warehouse"
cat > "$TMP/mixed/.coop/project.yml" <<EOF
repositories:
  analytics:
    role: mixed
    local_path: "$TMP/mixed/source"
    sql_root: warehouse
EOF
patch="$("$PY" "$ROOT/lib/_seeddocs.py" "$TMP/mixed/.coop/project.yml" 2>/dev/null)" || fail "mixed repo should seed both sides"
"$PY" - "$patch" <<'PYEOF' || fail "mixed repo patch wrong shape"
import json, sys
p = json.loads(sys.argv[1])["repos"]
assert set(p) == {"sql", "powerbi"}, p
assert p["sql"]["path"].endswith("warehouse"), p
assert p["powerbi"]["path"].endswith("source"), p
PYEOF
pass "mixed repository seeds both SQL and Power BI sources"

# 2. All-TODO contract -> exit 3, no patch.
mkdir -p "$TMP/empty/.coop"
printf 'repositories:\n  fabric:\n    local_path: "TODO: /x"\n' > "$TMP/empty/.coop/project.yml"
rc=0; out="$("$PY" "$ROOT/lib/_seeddocs.py" "$TMP/empty/.coop/project.yml" 2>/dev/null)" || rc=$?
[ "$rc" = 3 ] || fail "all-TODO contract should exit 3 (got $rc)"
[ -z "$out" ] || fail "all-TODO contract must print no patch"
pass "all-TODO contract -> exit 3, nothing to seed"

# 3. End-to-end `coop init --seed-docs` through bin/coop.ps1 against a shimmed
#    coop-data-doc: the patch is piped into config-set, the status line is shown
#    (#102), declining without --yes and a TODO-only contract change nothing.
PWSH="$(command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null || true)"
[ -n "$PWSH" ] || fail "pwsh (PowerShell 7) required: coop init --seed-docs is dispatched by bin/coop.ps1"
FIXTURE="$ROOT/tests/fixtures/seeddocs.test.ps1"
if command -v cygpath >/dev/null 2>&1; then FIXTURE="$(cygpath -w "$FIXTURE")"; fi
"$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$FIXTURE" || fail "coop init --seed-docs end-to-end cases (tests/fixtures/seeddocs.test.ps1)"

printf '  %s\n' "seed-docs tests passed"
