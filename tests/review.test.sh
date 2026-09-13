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
# provenance-complete canned JSON report there, and mimic the real exit contract
# (exit 2 under --strict, since the canned report "has findings"; exit 0 otherwise).
# The data-doc shim
# records argv and exits with COOP_TEST_DD_RC (default 0).
mkdir -p "$TMP/bin"
for t in coop-sql-review coop-dax-review; do
  schema=4; [ "$t" = coop-dax-review ] && schema=3
  cat > "$TMP/bin/$t" <<EOF
#!/bin/sh
echo "\$*" >> "$TMP/$t.args.log"
out=""; prev=""; standard=""; rc=0
for a in "\$@"; do
  [ "\$prev" = "-o" ] && out="\$a"
  [ "\$prev" = "--standards" ] && standard="\$a"
  [ "\$a" = "--strict" ] && rc=2
  prev="\$a"
done
hash=""; [ -n "\$standard" ] && hash="\$("$PY" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "\$standard")"
if [ -n "\$out" ]; then
  mode="\${COOP_TEST_PROVENANCE_MODE:-valid}"
  [ "$t" = coop-sql-review ] && mode="\${COOP_TEST_SQL_MODE:-\$mode}"
  [ "$t" = coop-dax-review ] && mode="\${COOP_TEST_DAX_MODE:-\$mode}"
  case "\$mode" in
    no_report) rm -f "\$out" ;;
    malformed) printf 'not-json' > "\$out" ;;
    missing) printf '{"tool":"%s","schema_version":$schema,"version":"test","files_checked":0,"models_checked":0,"findings":[],"diagnostics":[],"agent_review":[],"summary":{"error":0,"warning":0,"info":0},"verdict":{"clean":true,"highest_severity":null}}' "$t" > "\$out" ;;
    bad_path) printf '{"tool":"%s","schema_version":$schema,"version":"test","files_checked":0,"models_checked":0,"standards":{"path":"/wrong/path","sha256":"%s"},"findings":[],"diagnostics":[],"agent_review":[],"summary":{"error":0,"warning":0,"info":0},"verdict":{"clean":true,"highest_severity":null}}' "$t" "\$hash" > "\$out" ;;
    bad_hash) printf '{"tool":"%s","schema_version":$schema,"version":"test","files_checked":0,"models_checked":0,"standards":{"path":"%s","sha256":"%064d"},"findings":[],"diagnostics":[],"agent_review":[],"summary":{"error":0,"warning":0,"info":0},"verdict":{"clean":true,"highest_severity":null}}' "$t" "\$standard" 0 > "\$out" ;;
    bad_revision) printf '{"tool":"%s","schema_version":$schema,"version":"test","files_checked":0,"models_checked":0,"standards":{"path":"%s","sha256":"%s","revision":7},"findings":[],"diagnostics":[],"agent_review":[],"summary":{"error":0,"warning":0,"info":0},"verdict":{"clean":true,"highest_severity":null}}' "$t" "\$standard" "\$hash" > "\$out" ;;
    *) count_key=files_checked; [ "$t" = coop-dax-review ] && count_key=models_checked; printf '{"tool":"%s","schema_version":$schema,"version":"test","%s":1,"standards":{"path":"%s","sha256":"%s"},"findings":[{"file":"fixture","line":1,"rule_id":"TEST","message":"test finding","severity":"warning"}],"diagnostics":[],"agent_review":[],"summary":{"error":0,"warning":1,"info":0},"verdict":{"clean":false,"highest_severity":"warning"}}' "$t" "\$count_key" "\$standard" "\$hash" > "\$out" ;;
  esac
fi
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
mkdir -p "$TMP/proj/.coop" "$TMP/proj/sqlrepo" "$TMP/proj/standards"
printf '# SQL test standard\n' > "$TMP/proj/standards/sql.md"
printf '# DAX test standard\n' > "$TMP/proj/standards/dax.md"
cat > "$TMP/proj/.coop/project.yml" <<EOF
standards:
  sql: "standards/sql.md"
  dax: "standards/dax.md"
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
  ( cd "$TMP/proj" && PATH="$TMP/bin:$PATH" NO_COLOR=1 COOP_STANDARDS_SNAPSHOT_ROOT="$TMP/snapshots" bash "$ROOT/bin/coop" review "$@" )
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
"$PY" -c 'import json,sys; r=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); assert "revision" not in r["standards"]; assert b["owner"]=="coop" and b["revision"]=="project-local" and b["path"]==r["standards"]["path"] and b["sha256"]==r["standards"]["sha256"]' \
  "$TMP/proj/.coop/reviews/coop-sql-review.json" "$TMP/proj/.coop/reviews/coop-sql-review.provenance.json" \
  || fail "aggregate wrapper provenance binding is missing or rewrote reviewer claims"
for t in coop-sql-review coop-dax-review; do
  grep -q "check $TMP/proj/sqlrepo --format json" "$TMP/$t.args.log" || fail "$t did not get the contract scope"
  grep -q -- "TODO" "$TMP/$t.args.log" && fail "$t was handed a TODO placeholder path"
  grep -q -- "no-such-dir" "$TMP/$t.args.log" && fail "$t was handed a missing path"
done
sql_snapshot="$("$PY" -c 'import sys; a=open(sys.argv[1]).read().split(); print(a[a.index("--standards")+1])' "$TMP/coop-sql-review.args.log")"
dax_snapshot="$("$PY" -c 'import sys; a=open(sys.argv[1]).read().split(); print(a[a.index("--standards")+1])' "$TMP/coop-dax-review.args.log")"
case "$sql_snapshot" in "$TMP"/snapshots/*-sql.md) ;; *) fail "SQL aggregate review did not get an immutable snapshot" ;; esac
case "$dax_snapshot" in "$TMP"/snapshots/*-dax.md) ;; *) fail "DAX aggregate review did not get an immutable snapshot" ;; esac
cmp -s "$sql_snapshot" "$TMP/proj/standards/sql.md" || fail "SQL snapshot is not byte-identical to the project standard"
cmp -s "$dax_snapshot" "$TMP/proj/standards/dax.md" || fail "DAX snapshot is not byte-identical to the project standard"
grep -q -- "build --non-interactive" "$TMP/coop-data-doc.args.log" || fail "data-doc build --non-interactive not invoked"
grep -q -- "--reviews $TMP/proj/.coop/reviews/coop-sql-review.json" "$TMP/coop-data-doc.args.log" || fail "data-doc did not receive the sql --reviews file"
grep -q -- "--reviews $TMP/proj/.coop/reviews/coop-dax-review.json" "$TMP/coop-data-doc.args.log" || fail "data-doc did not receive the dax --reviews file"
pass "contract scope + same-source standards: JSONs saved, missing skipped, exact standards and reviews passed"

# 1b. Configured canonical review paths must never expose a rejected current
# report. Keep the accepted reports as LKG, skip configured docs composition,
# quarantine raw output, and exclude it from suite HTML.
cat > "$TMP/proj/coop-data-doc.yml" <<EOF
reviews:
  - .coop/reviews/coop-sql-review.json
  - .coop/reviews/coop-dax-review.json
EOF
cp "$TMP/proj/.coop/reviews/coop-sql-review.json" "$TMP/sql.accepted"
cp "$TMP/proj/.coop/reviews/coop-dax-review.json" "$TMP/dax.accepted"
cp "$TMP/proj/.coop/reviews/coop-sql-review.provenance.json" "$TMP/sql-binding.accepted"
cp "$TMP/proj/.coop/reviews/coop-dax-review.provenance.json" "$TMP/dax-binding.accepted"
mkdir -p "$TMP/proj/.coop/reviews/rejected"
for mode in no_report malformed missing bad_path bad_hash bad_revision; do
  before_quarantine="$(find "$TMP/proj/.coop/reviews/rejected" -type f -size +0c | wc -l | tr -d ' ')"
  rm -f "$TMP/coop-data-doc.args.log"
  rc=0
  out="$(COOP_TEST_PROVENANCE_MODE="$mode" run_review --html 2>&1)" || rc=$?
  [ "$rc" -eq 2 ] || fail "$mode provenance should fail closed with exit 2 (got $rc)"
  case "$out" in *"run rejected"*) ;; *) fail "$mode rejection diagnostic missing" ;; esac
  cmp -s "$TMP/sql.accepted" "$TMP/proj/.coop/reviews/coop-sql-review.json" || fail "$mode replaced the accepted SQL report"
  cmp -s "$TMP/dax.accepted" "$TMP/proj/.coop/reviews/coop-dax-review.json" || fail "$mode replaced the accepted DAX report"
  cmp -s "$TMP/sql-binding.accepted" "$TMP/proj/.coop/reviews/coop-sql-review.provenance.json" || fail "$mode replaced the trusted SQL binding"
  cmp -s "$TMP/dax-binding.accepted" "$TMP/proj/.coop/reviews/coop-dax-review.provenance.json" || fail "$mode replaced the trusted DAX binding"
  [ ! -f "$TMP/coop-data-doc.args.log" ] || fail "$mode reached configured coop-data-doc ingestion"
  [ ! -f "$TMP/proj/.coop/reviews/suite.html" ] || fail "$mode generated suite HTML from a rejected or stale report"
  if [ "$mode" != no_report ]; then
    after_quarantine="$(find "$TMP/proj/.coop/reviews/rejected" -type f -size +0c | wc -l | tr -d ' ')"
    [ "$after_quarantine" -gt "$before_quarantine" ] || fail "$mode raw reviewer output was not quarantined"
  fi
done
pass "rejected reports are quarantined; accepted LKG/configured docs/suite HTML stay isolated"

# 1c. One valid/one rejected is one rejected run: neither report/binding advances.
for pair in "valid bad_hash" "bad_hash valid"; do
  set -- $pair
  rm -f "$TMP/coop-data-doc.args.log"
  rc=0; out="$(COOP_TEST_SQL_MODE="$1" COOP_TEST_DAX_MODE="$2" run_review --html 2>&1)" || rc=$?
  [ "$rc" -eq 2 ] || fail "asymmetric $pair should fail closed"
  cmp -s "$TMP/sql.accepted" "$TMP/proj/.coop/reviews/coop-sql-review.json" || fail "asymmetric $pair advanced SQL"
  cmp -s "$TMP/dax.accepted" "$TMP/proj/.coop/reviews/coop-dax-review.json" || fail "asymmetric $pair advanced DAX"
  cmp -s "$TMP/sql-binding.accepted" "$TMP/proj/.coop/reviews/coop-sql-review.provenance.json" || fail "asymmetric $pair advanced SQL binding"
  cmp -s "$TMP/dax-binding.accepted" "$TMP/proj/.coop/reviews/coop-dax-review.provenance.json" || fail "asymmetric $pair advanced DAX binding"
  [ ! -f "$TMP/proj/.coop/reviews/suite.html" ] || fail "asymmetric $pair emitted partial suite HTML"
  [ ! -f "$TMP/coop-data-doc.args.log" ] || fail "asymmetric $pair reached data-doc"
done
pass "asymmetric SQL/DAX mutation preserves one coherent accepted run"

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


# 8. --diff: uses git to construct the scope (changed files only).
rm -f "$TMP"/coop-*.args.log
( cd "$TMP/proj" && git init -q && git config user.email "test@example.com" && git config user.name "Test" && mkdir -p sqlrepo && echo "--" > sqlrepo/old.sql && git add sqlrepo/old.sql && git commit -q -m "init" )
( cd "$TMP/proj" && touch sqlrepo/new.sql )
out="$(run_review --skip-docs --diff 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || { printf '%s\n' "$out" >&2; fail "coop review --diff should exit 0 (got $rc)"; }
grep -q "sqlrepo/new.sql" "$TMP/coop-sql-review.args.log" || fail "--diff did not pass the changed file"
grep -q "sqlrepo/old.sql" "$TMP/coop-sql-review.args.log" && fail "--diff passed an unchanged file"
pass "--diff scopes to changed files via git"
printf '  %s\n' "review tests passed"
