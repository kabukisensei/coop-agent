#!/usr/bin/env bash
#
# coop review: composite linter run + lineage-docs composition, against shimmed
# coop-sql-review / coop-dax-review / coop-data-doc. Fully offline.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

PY="$(command -v python3 || command -v python)" || fail "python required for this test"

# Shim the three tools. The linter shims record argv, honor `-o FILE` by writing a
# canned JSON report there, and mimic the real exit contract (exit 2 under --strict,
# since the canned report "has findings"; exit 0 otherwise). The data-doc shim
# records argv and exits with COOP_TEST_DD_RC (default 0).
mkdir -p "$TMP/bin"
for t in coop-sql-review coop-dax-review; do
  cat > "$TMP/bin/$t" <<EOF
#!/bin/sh
echo "\$*" >> "$TMP/$t.args.log"
out=""; prev=""; rc=0
for a in "\$@"; do
  [ "\$prev" = "-o" ] && out="\$a"
  [ "\$a" = "--strict" ] && rc=2
  prev="\$a"
done
[ -n "\$out" ] && printf '{"findings": [{"severity": "warning"}], "summary": {"error": 0, "warning": 1, "info": 0}}' > "\$out"
exit "\$rc"
EOF
  chmod +x "$TMP/bin/$t"
done
cat > "$TMP/bin/coop-data-doc" <<EOF
#!/bin/sh
echo "\$*" >> "$TMP/coop-data-doc.args.log"
exit "\${COOP_TEST_DD_RC:-0}"
EOF
chmod +x "$TMP/bin/coop-data-doc"

# A work repo with a contract: one existing repo path, one TODO leftover, one
# path that doesn't exist on this machine.
mkdir -p "$TMP/proj/.coop" "$TMP/proj/sqlrepo"
cat > "$TMP/proj/.coop/project.yml" <<EOF
repositories:
  fabric_dw:
    description: "Warehouse SQL"
    local_path: "sqlrepo"
  extras:
    local_path: "TODO: /path/to/extras"
  gone:
    local_path: "no-such-dir"
EOF

run_review() {  # [extra coop args...] — runs `coop review` from $TMP/proj with the shims first on PATH
  ( cd "$TMP/proj" && PATH="$TMP/bin:$PATH" NO_COLOR=1 bash "$ROOT/bin/coop" review "$@" )
}

# 1. Contract scope: both JSON reports land in .coop/reviews/, the resolved repo
#    path (not the TODO / missing ones) is the linters' scope, and the data-doc
#    build received BOTH --reviews files.
out="$(run_review 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || { printf '%s\n' "$out" >&2; fail "coop review should exit 0 (got $rc)"; }
[ -f "$TMP/proj/.coop/reviews/coop-sql-review.json" ] || fail "sql JSON missing from .coop/reviews/"
[ -f "$TMP/proj/.coop/reviews/coop-dax-review.json" ] || fail "dax JSON missing from .coop/reviews/"
"$PY" -c "import json,sys; json.load(open(sys.argv[1]))" "$TMP/proj/.coop/reviews/coop-sql-review.json" \
  || fail "the saved sql report is not valid JSON"
for t in coop-sql-review coop-dax-review; do
  grep -q "check $TMP/proj/sqlrepo --format json" "$TMP/$t.args.log" || fail "$t did not get the contract scope"
  grep -q -- "TODO" "$TMP/$t.args.log" && fail "$t was handed a TODO placeholder path"
  grep -q -- "no-such-dir" "$TMP/$t.args.log" && fail "$t was handed a missing path"
done
grep -q -- "build --non-interactive" "$TMP/coop-data-doc.args.log" || fail "data-doc build --non-interactive not invoked"
grep -q -- "--reviews $TMP/proj/.coop/reviews/coop-sql-review.json" "$TMP/coop-data-doc.args.log" || fail "data-doc did not receive the sql --reviews file"
grep -q -- "--reviews $TMP/proj/.coop/reviews/coop-dax-review.json" "$TMP/coop-data-doc.args.log" || fail "data-doc did not receive the dax --reviews file"
pass "contract scope: JSONs in .coop/reviews/, TODO/missing skipped, data-doc got both --reviews"

# 2. --skip-docs: linters run, data-doc is never called.
rm -f "$TMP/coop-data-doc.args.log" "$TMP"/coop-*-review.args.log
out="$(run_review --skip-docs 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || { printf '%s\n' "$out" >&2; fail "coop review --skip-docs should exit 0 (got $rc)"; }
[ -f "$TMP/coop-sql-review.args.log" ] || fail "--skip-docs must still run the linters"
[ ! -f "$TMP/coop-data-doc.args.log" ] || fail "--skip-docs must not invoke coop-data-doc"
pass "--skip-docs runs the linters only"

# 3. Explicit paths win over the contract scope.
rm -f "$TMP"/coop-*.args.log
mkdir -p "$TMP/elsewhere"
out="$(run_review "$TMP/elsewhere" --skip-docs 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || { printf '%s\n' "$out" >&2; fail "explicit-path review should exit 0 (got $rc)"; }
grep -q "check $TMP/elsewhere --format json" "$TMP/coop-sql-review.args.log" || fail "explicit path not passed to the linter"
grep -q "sqlrepo" "$TMP/coop-sql-review.args.log" && fail "contract scope leaked in despite explicit paths"
pass "explicit paths win over the contract"

# 4. --strict: passed to both linters; a failing linter makes coop review exit 2.
rm -f "$TMP"/coop-*.args.log
rc=0; run_review --strict --skip-docs >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "--strict with failing linters should exit 2 (got $rc)"
grep -q -- "--strict" "$TMP/coop-sql-review.args.log" || fail "--strict not passed to coop-sql-review"
grep -q -- "--strict" "$TMP/coop-dax-review.args.log" || fail "--strict not passed to coop-dax-review"
pass "--strict flows to both linters and exits 2 on a failing linter"

# 5. data-doc's friendly "no config" exit 1 is a hint, not a failure; a hard
#    exit 2 propagates.
rc=0
( cd "$TMP/proj" && PATH="$TMP/bin:$PATH" NO_COLOR=1 COOP_TEST_DD_RC=1 bash "$ROOT/bin/coop" review ) >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] || fail "data-doc exit 1 (no config) must not fail the run (got $rc)"
rc=0
( cd "$TMP/proj" && PATH="$TMP/bin:$PATH" NO_COLOR=1 COOP_TEST_DD_RC=2 bash "$ROOT/bin/coop" review ) >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "data-doc exit 2 (hard failure) must propagate (got $rc)"
pass "data-doc no-config is a hint; a hard failure propagates"

# 6. No contract + no paths dies with guidance — never blind-scans the cwd.
#    A fake COOP_ROOT (real copy of bin/coop, lib symlinked) removes the bundled
#    .coop/project.yml fallback so "no contract anywhere" is reproducible.
mkdir -p "$TMP/fakeroot/bin" "$TMP/nowhere"
cp "$ROOT/bin/coop" "$TMP/fakeroot/bin/coop"
ln -s "$ROOT/lib" "$TMP/fakeroot/lib"
cp "$ROOT/VERSION" "$TMP/fakeroot/VERSION"
rm -f "$TMP"/coop-*.args.log
rc=0
out="$(cd "$TMP/nowhere" && PATH="$TMP/bin:$PATH" NO_COLOR=1 bash "$TMP/fakeroot/bin/coop" review 2>&1)" || rc=$?
[ "$rc" -ne 0 ] || fail "no-contract + no-paths must exit non-zero"
case "$out" in
  *".coop/project.yml"*"pass paths"*) ;;
  *) fail "die message should point at .coop/project.yml and passing paths (got: $out)" ;;
esac
[ ! -f "$TMP/coop-sql-review.args.log" ] || fail "no-contract run must not invoke the linters"
pass "no contract + no paths dies with guidance, no blind cwd scan"

# 7. --compare: after a prior report exists, each linter is handed --diff-against a
#    snapshot of the previous report; a first run (no prior report) passes none.
reviews="$TMP/proj/.coop/reviews"
rm -f "$TMP"/coop-*.args.log "$reviews"/*.json
run_review --skip-docs >/dev/null 2>&1                       # baseline run: writes the reports
rm -f "$TMP"/coop-*.args.log
out="$(run_review --skip-docs --compare 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || { printf '%s\n' "$out" >&2; fail "coop review --compare should exit 0 (got $rc)"; }
grep -q -- "--diff-against" "$TMP/coop-sql-review.args.log" || fail "--compare did not pass --diff-against to coop-sql-review"
grep -q -- "--diff-against" "$TMP/coop-dax-review.args.log" || fail "--compare did not pass --diff-against to coop-dax-review"
rm -f "$TMP"/coop-*.args.log "$reviews"/*.json               # no prior report now
run_review --skip-docs --compare >/dev/null 2>&1
grep -q -- "--diff-against" "$TMP/coop-sql-review.args.log" && fail "--compare on a first run must not pass --diff-against"
pass "--compare diffs against the previous report (baseline no-op on the first run)"

printf '  %s\n' "review tests passed"
