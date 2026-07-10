#!/usr/bin/env bash
#
# coop init --seed-docs (issue #25): lib/_seeddocs.py classification + the
# bin/coop flow against a shimmed coop-data-doc. Fully offline.
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

# 2. All-TODO contract -> exit 3, no patch.
mkdir -p "$TMP/empty/.coop"
printf 'repositories:\n  fabric:\n    local_path: "TODO: /x"\n' > "$TMP/empty/.coop/project.yml"
rc=0; out="$("$PY" "$ROOT/lib/_seeddocs.py" "$TMP/empty/.coop/project.yml" 2>/dev/null)" || rc=$?
[ "$rc" = 3 ] || fail "all-TODO contract should exit 3 (got $rc)"
[ -z "$out" ] || fail "all-TODO contract must print no patch"
pass "all-TODO contract -> exit 3, nothing to seed"

# 3. End-to-end `coop init --seed-docs` against a shimmed coop-data-doc:
#    the shim records its args and writes stdin (the patch) to a file.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/coop-data-doc" <<EOF
#!/bin/sh
echo "\$*" >> "$TMP/dd-args.log"
cat > "$TMP/dd-stdin.json"
exit 0
EOF
chmod +x "$TMP/bin/coop-data-doc"
PATH="$TMP/bin:$PATH" COOP_ASSUME_YES=1 NO_COLOR=1 bash "$ROOT/bin/coop" init --seed-docs "$TMP/proj" >/dev/null 2>&1 \
  || fail "coop init --seed-docs should succeed"
grep -q -- "--from-json -" "$TMP/dd-args.log" || fail "config-set --from-json - not invoked"
grep -q -- "--config $TMP/proj/coop-data-doc.yml" "$TMP/dd-args.log" || fail "config-set should target the project dir's coop-data-doc.yml"
"$PY" -c "import json,sys; p=json.load(open(sys.argv[1])); assert 'repos' in p and 'sql' in p['repos'] and 'powerbi' in p['repos']" "$TMP/dd-stdin.json" \
  || fail "the patch piped to config-set is wrong"
pass "coop init --seed-docs pipes the repos patch into coop-data-doc config-set"

# 4. Declining leaves everything untouched (non-interactive without --yes refuses).
rm -f "$TMP/dd-args.log" "$TMP/dd-stdin.json"
rc=0
PATH="$TMP/bin:$PATH" NO_COLOR=1 bash "$ROOT/bin/coop" init --seed-docs "$TMP/proj" </dev/null >/dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] || fail "declining should exit non-zero"
[ ! -f "$TMP/dd-stdin.json" ] || fail "declining must not invoke config-set"
pass "declining the confirmation changes nothing"

# 5. Seed on a still-TODO contract warns and exits non-zero without calling the tool.
rc=0
PATH="$TMP/bin:$PATH" COOP_ASSUME_YES=1 NO_COLOR=1 bash "$ROOT/bin/coop" init --seed-docs "$TMP/empty" >/dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] || fail "TODO-only contract should exit non-zero"
[ ! -f "$TMP/dd-stdin.json" ] || fail "TODO-only contract must not invoke config-set"
pass "TODO-only contract: warns, exits non-zero, config-set never called"

printf '  %s\n' "seed-docs tests passed"
