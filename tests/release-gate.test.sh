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

# --- the release itself, in disposable repositories ---------------------------------
# Every origin is a local bare repository, so nothing leaves this machine; git is
# hermetic (no user or system config, a fixed identity). --no-check keeps GitHub,
# the sibling coop-website and the wiki out of it.
export HOME="$TMP/home" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='Coop Release Test' GIT_AUTHOR_EMAIL='coop-release-test@example.invalid'
export GIT_COMMITTER_NAME='Coop Release Test' GIT_COMMITTER_EMAIL='coop-release-test@example.invalid'
mkdir -p "$HOME"
new_repo() { # <dir> -> a release-ready checkout at 1.2.3 on main == origin/main; its origin is <dir>.git
  local t="$1"
  mkdir -p "$t/config" "$t/extensions/a" "$t/scripts"
  printf '1.2.3\n' > "$t/VERSION"
  printf '{\n  "coop_version": "1.2.3",\n  "pi": {}\n}\n' > "$t/config/release-manifest.json"
  printf '{\n  "name": "a",\n  "version": "1.2.3"\n}\n' > "$t/extensions/a/package.json"
  printf '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- a thing\n\n## [1.2.3] — 2026-01-01\n\n- old\n' > "$t/CHANGELOG.md"
  cp "$ROOT/scripts/bump-version.sh" "$t/scripts/bump-version.sh"
  git init -q "$t"; git -C "$t" symbolic-ref HEAD refs/heads/main
  git -C "$t" add . && git -C "$t" commit -q -m fixture
  git init -q --bare "$t.git"; git -C "$t.git" symbolic-ref HEAD refs/heads/main
  git -C "$t" remote add origin "$t.git" && git -C "$t" push -q -u origin main
}
release_in() { # <dir> <args...> -> the release's output, then " rc=N"
  local t="$1"; shift
  ( COOP_ROOT="$t"; ( coop_release "$@" 2>&1 ); echo " rc=$?" )
}
origin_tags() { git -C "$1.git" tag -l; }
unchanged() { # <dir> <head0>: HEAD, the tree, VERSION and both tag lists are as before
  [ "$(git -C "$1" rev-parse HEAD)" = "$2" ] && [ -z "$(git -C "$1" status --porcelain)" ] \
    && [ "$(cat "$1/VERSION")" = "1.2.3" ] && [ -z "$(git -C "$1" tag -l)" ] && [ -z "$(origin_tags "$1")" ]
}

r="$TMP/happy"; new_repo "$r"
got="$(release_in "$r" --yes --no-check)"
case "$got" in *"released v1.2.3: pushed tag v1.2.3"*"rc=0") ok "a release-ready main is tagged and the tag pushed" ;; *) ko "happy release: '$got'" ;; esac
git -C "$r" rev-parse -q --verify refs/tags/v1.2.3 >/dev/null && ok "the tag exists here" || ko "no local tag v1.2.3"
[ "$(origin_tags "$r")" = "v1.2.3" ] && ok "the tag reached origin" || ko "origin tags: '$(origin_tags "$r")'"
git -C "$r.git" merge-base --is-ancestor v1.2.3 refs/heads/main && ok "the tag is on origin main" || ko "origin tag off main"
[ "$(git -C "$r.git" rev-parse refs/heads/main)" = "$(git -C "$r" rev-parse HEAD)" ] && ok "origin main did not move (the release commits nothing)" || ko "origin main moved"
got="$(release_in "$r" --yes --no-check)"
case "$got" in *"tag v1.2.3 already exists here"*"rc=1") ok "a second release of the same version is refused" ;; *) ko "released twice: '$got'" ;; esac

r="$TMP/levels"; new_repo "$r"; head0="$(git -C "$r" rev-parse HEAD)"
got="$(release_in "$r" patch --yes --no-check)"
case "$got" in *"the version bump is a pull request now"*"rc=1") ok "coop release patch names the release pull request" ;; *) ko "release patch: '$got'" ;; esac
unchanged "$r" "$head0" && ok "a bump level changes nothing" || ko "release patch changed something"

# The two steps by hand: bump on a branch, merge (push) to main, then tag.
r="$TMP/twostep"; new_repo "$r"
(cd "$r" && bash scripts/bump-version.sh patch --date 2026-10-26 >/dev/null)
git -C "$r" add . && git -C "$r" commit -q -m 'Release v1.2.4' && git -C "$r" push -q origin main
got="$(release_in "$r" --yes --no-check)"
case "$got" in *"agree on 1.2.4, not yet tagged"*"released v1.2.4"*"rc=0") ok "after the bump has merged, coop release tags the new version" ;; *) ko "two-step release: '$got'" ;; esac
[ "$(origin_tags "$r")" = "v1.2.4" ] && ok "v1.2.4 reached origin" || ko "origin tags after the bump: '$(origin_tags "$r")'"

r="$TMP/mismatch"; new_repo "$r"
printf '{\n  "coop_version": "0.0.0",\n  "pi": {}\n}\n' > "$r/config/release-manifest.json"
git -C "$r" commit -q -am mismatch && git -C "$r" push -q origin main
got="$(release_in "$r" --yes --no-check)"
case "$got" in *"coop_version ('0.0.0') does not match VERSION ('1.2.3')"*"rc=1") ok "a manifest that disagrees with VERSION is refused, naming the release PR" ;; *) ko "mismatch: '$got'" ;; esac
[ -z "$(git -C "$r" tag -l)" ] && [ -z "$(origin_tags "$r")" ] && ok "the mismatch tagged nothing" || ko "mismatch tagged"

r="$TMP/rejected"; new_repo "$r"
# origin refuses every tag, as a protected ref or a lost race would.
printf '#!/bin/sh\ncase "$1" in refs/tags/*) echo "tags are protected" >&2; exit 1 ;; esac\nexit 0\n' > "$r.git/hooks/update"; chmod +x "$r.git/hooks/update"
got="$(release_in "$r" --yes --no-check)"
case "$got" in *"v1.2.3 exists only on this machine. Retry: git push origin v1.2.3"*"rc=1") ok "a rejected tag push fails with the retry command" ;; *) ko "rejected push: '$got'" ;; esac
[ -z "$(origin_tags "$r")" ] && ok "origin has no tag after the rejection" || ko "tag reached origin despite the hook"

refused() { # <dir> <label> <wanted text>
  local t="$1" label="$2" want="$3" head0 got
  head0="$(git -C "$t" rev-parse HEAD)"
  got="$(release_in "$t" --yes --no-check)"
  case "$got" in *"$want"*"rc=1") ok "$label: refused, naming the fix" ;; *) ko "$label: '$got'" ;; esac
  unchanged "$t" "$head0" && ok "$label: nothing changed here or on origin" || ko "$label: the refused release changed something"
}
r="$TMP/detached"; new_repo "$r"; git -C "$r" checkout -q --detach
refused "$r" "detached HEAD" "HEAD is detached"
r="$TMP/branch"; new_repo "$r"; git -C "$r" checkout -q -b topic
refused "$r" "another branch" "on branch 'topic'"
r="$TMP/behind"; new_repo "$r"
git clone -q "$r.git" "$TMP/behind-other"; git -C "$TMP/behind-other" commit -q --allow-empty -m 'merged elsewhere'; git -C "$TMP/behind-other" push -q origin main
refused "$r" "main behind origin/main" "0 ahead, 1 behind"
r="$TMP/ahead"; new_repo "$r"; git -C "$r" commit -q --allow-empty -m 'local only'
refused "$r" "main ahead of origin/main" "1 ahead, 0 behind"
r="$TMP/dirty"; new_repo "$r"; echo x > "$r/stray"
got="$(release_in "$r" --yes --no-check)"
case "$got" in *"working tree not clean"*"rc=1") ok "a dirty tree is refused" ;; *) ko "dirty tree: '$got'" ;; esac

echo "release gate: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
