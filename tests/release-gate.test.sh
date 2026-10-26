#!/usr/bin/env bash
# The release gate (scripts/release.sh): coop release verifies GitHub CI on the
# commit, the tree's one X.Y.Z and the bundle, then tags. This checks the verdict
# reader against saved check-runs responses, the tree check and
# scripts/bump-version.sh on a copy, offline; the live gate is Aaron's releases.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
ko() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# shellcheck disable=SC1091
. "$ROOT/scripts/release.sh"   # functions only: the entry point runs only when executed

verdict_for() { # <json> -> verdict line
  printf '%s' "$1" > "$TMP/checks.json"
  COOP_RELEASE_CHECKS_JSON="$TMP/checks.json" coop_release_ci_verdict deadbeef
}
expect() { # <label> <expected-prefix> <json>
  local got; got="$(verdict_for "$3")"
  case "$got" in
    "$2"*) ok "$1: $got" ;;
    *) ko "$1: expected '$2…', got '$got'" ;;
  esac
}

expect "all check runs green" "green 3" '{"total_count":3,"check_runs":[
  {"name":"gate","status":"completed","conclusion":"success"},
  {"name":"installer (Windows)","status":"completed","conclusion":"success"},
  {"name":"docs","status":"completed","conclusion":"skipped"}]}'
expect "a check still running wins over green ones" "running installer (Windows)" '{"check_runs":[
  {"name":"gate","status":"completed","conclusion":"success"},
  {"name":"installer (Windows)","status":"in_progress","conclusion":null}]}'
expect "a queued check counts as running" "running gate" '{"check_runs":[
  {"name":"gate","status":"queued","conclusion":null}]}'
expect "a failed check is red, named with its conclusion" "red gate (failure)" '{"check_runs":[
  {"name":"gate","status":"completed","conclusion":"failure"},
  {"name":"docs","status":"completed","conclusion":"success"}]}'
expect "red wins over still-running" "red gate (cancelled)" '{"check_runs":[
  {"name":"gate","status":"completed","conclusion":"cancelled"},
  {"name":"installer (Windows)","status":"in_progress","conclusion":null}]}'
expect "no check runs on the commit" "none" '{"total_count":0,"check_runs":[]}'
expect "a non-JSON response is unreachable" "unreachable" 'Not Found'
got="$(COOP_RELEASE_CHECKS_JSON="$TMP/absent.json" coop_release_ci_verdict deadbeef)"
case "$got" in unreachable*) ok "an unreadable saved response is unreachable" ;; *) ko "unreadable file: got '$got'" ;; esac

# The remote parser: origin spellings that are github.com, and one that is not.
git_remote_for() { ( COOP_ROOT="$TMP/r$RANDOM"; git init -q "$COOP_ROOT"; git -C "$COOP_ROOT" remote add origin "$1"; coop_release_github_repo ); }
[ "$(git_remote_for https://github.com/kabukisensei/coop-agent.git)" = "kabukisensei/coop-agent" ] && ok "https origin -> owner/repo" || ko "https origin"
[ "$(git_remote_for git@github.com:kabukisensei/coop-agent.git)" = "kabukisensei/coop-agent" ] && ok "ssh origin -> owner/repo" || ko "ssh origin"
[ -z "$(git_remote_for https://dev.azure.com/org/proj/_git/repo)" ] && ok "non-GitHub origin -> empty (gate reports unreachable)" || ko "non-GitHub origin"

# --- the bundled-standards gate (#434): bundle revision vs the wiki's branch head ---
bundle_verdict() { # <remote head or ''> -> stdout+stderr of the gate, then "rc=N"
  local remote_head="$1"
  # The gate dies (exit) on a stale bundle, so it runs in its own subshell and
  # the rc line is printed outside it.
  ( coop_release_wiki_head() { [ -n "$remote_head" ] && printf '%s' "$remote_head"; }
    coop_confirm() { return 1; }
    ( coop_release_check_bundle 0 2>&1 ); echo "rc=$?" )
}
bundle_rev="$(coop_release_bundle_field revision)"
case "$bundle_rev" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ok "bundle.json carries a revision (${bundle_rev:0:7})" ;;
  *) ko "bundle.json revision unreadable: '$bundle_rev'" ;;
esac
got="$(bundle_verdict "$bundle_rev")"
case "$got" in *"bundled standards are the wiki's current main"*"rc=0") ok "a bundle at the wiki head passes" ;; *) ko "bundle at head: $got" ;; esac
got="$(bundle_verdict 0123456789abcdef0123456789abcdef01234567)"
case "$got" in *"refresh it"*"rc=1") ok "a bundle behind the wiki head dies with the refresh command" ;; *) ko "stale bundle: $got" ;; esac
got="$(bundle_verdict "")"
case "$got" in *"can't verify"*"rc=1") ok "an unreachable wiki warns and the declined confirm cancels" ;; *) ko "unreachable wiki: $got" ;; esac
got="$( ( coop_release_wiki_head() { return 1; }; coop_release_check_bundle 1 2>&1; echo "rc=$?" ) )"
case "$got" in *"continuing (--yes)"*"rc=0") ok "an unreachable wiki continues under --yes with a note" ;; *) ko "unreachable wiki --yes: $got" ;; esac


# --- the tree check and the bump, on a copy of the release-bearing files ---------
tree_copy() { # -> a temp tree with VERSION, the manifest, two extensions and a CHANGELOG
  local t="$TMP/tree$RANDOM"; mkdir -p "$t/config" "$t/extensions/a" "$t/extensions/b"
  printf '1.2.3\n' > "$t/VERSION"
  printf '{\n  "coop_version": "1.2.3",\n  "pi": {}\n}\n' > "$t/config/release-manifest.json"
  printf '{\n  "name": "a",\n  "version": "1.2.3"\n}\n' > "$t/extensions/a/package.json"
  printf '{\n  "name": "b",\n  "version": "1.2.3"\n}\n' > "$t/extensions/b/package.json"
  printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- a thing\n\n## [1.2.3] — 2026-01-01\n\n- old\n' > "$t/CHANGELOG.md"
  printf '%s' "$t"
}
check_tree() { ( COOP_ROOT="$1"; ( coop_release_check_tree 2>&1 ); echo " rc=$?" ) }
t="$(tree_copy)"
got="$(check_tree "$t")"
case "$got" in "1.2.3 rc=0") ok "a consistent tree prints its version" ;; *) ko "consistent tree: '$got'" ;; esac
printf '1.2.4\n' > "$t/VERSION"
got="$(check_tree "$t")"
case "$got" in *"coop_version ('1.2.3') does not match VERSION ('1.2.4')"*"rc=1") ok "a manifest behind VERSION dies naming the release PR" ;; *) ko "manifest behind: '$got'" ;; esac
t="$(tree_copy)"; printf '{\n  "name": "b",\n  "version": "1.2.2"\n}\n' > "$t/extensions/b/package.json"
got="$(check_tree "$t")"
case "$got" in *"extensions/b/package.json is at '1.2.2'"*"rc=1") ok "an extension behind VERSION dies" ;; *) ko "extension behind: '$got'" ;; esac
t="$(tree_copy)"; printf '# Changelog\n\n## [Unreleased]\n' > "$t/CHANGELOG.md"
got="$(check_tree "$t")"
case "$got" in *"no '## [1.2.3]' section"*"rc=1") ok "a CHANGELOG without the version's section dies" ;; *) ko "no changelog section: '$got'" ;; esac

t="$(tree_copy)"
# the script resolves ROOT from its own location, so run a copy placed in <tree>/scripts
mkdir -p "$t/scripts"; cp "$ROOT/scripts/bump-version.sh" "$t/scripts/bump-version.sh"
got="$( (bash "$t/scripts/bump-version.sh" minor --date 2026-10-26 2>&1); echo " rc=$?" )"
case "$got" in "1.3.0"*"rc=0") ok "bump minor prints 1.3.0" ;; *) ko "bump minor: '$got'" ;; esac
[ "$(cat "$t/VERSION")" = "1.3.0" ] && ok "VERSION moved" || ko "VERSION is $(cat "$t/VERSION")"
grep -q '"coop_version": "1.3.0"' "$t/config/release-manifest.json" && ok "manifest coop_version moved" || ko "manifest not moved"
grep -q '"version": "1.3.0"' "$t/extensions/a/package.json" && grep -q '"version": "1.3.0"' "$t/extensions/b/package.json" && ok "every extension moved" || ko "extensions not moved"
grep -q '^## \[1.3.0\] — 2026-10-26$' "$t/CHANGELOG.md" && ok "CHANGELOG rolled [Unreleased] into a dated [1.3.0]" || ko "CHANGELOG not rolled: $(head -n 6 "$t/CHANGELOG.md")"
got="$( (cd "$t" && COOP_ROOT="$t" coop_release_check_tree 2>&1); echo " rc=$?" )"
case "$got" in "1.3.0"*"rc=0") ok "the bumped tree passes the tree check" ;; *) ko "bumped tree check: '$got'" ;; esac
got="$( (bash "$t/scripts/bump-version.sh" 1.2.9 2>&1); echo " rc=$?" )"
case "$got" in *"older than the current 1.3.0"*"rc=1") ok "an explicit older version is refused" ;; *) ko "older version: '$got'" ;; esac
got="$( (bash "$t/scripts/bump-version.sh" 2.0.0 --date 2026-11-01 2>&1); echo " rc=$?" )"
case "$got" in *"nothing under [Unreleased]"*"2.0.0"*"rc=0") ok "an explicit newer version is taken, with a note that [Unreleased] is empty" ;; *) ko "explicit version: '$got'" ;; esac
got="$( (bash "$t/scripts/bump-version.sh" 1.2 2>&1); echo " rc=$?" )"
case "$got" in *"rc=1") ok "a malformed version is refused" ;; *) ko "malformed version: '$got'" ;; esac

echo "release gate: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
