#!/usr/bin/env bash
#
# Repo-staleness helpers (lib/common.sh): coop_repo_fetch_throttled +
# coop_repo_behind_count + coop_update_nudge. Fully offline — the "origin" is a
# local repo in the sandbox, so `git fetch` never touches the network.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

# A local "origin" with two commits, and a clone of it.
git init --quiet "$TMP/origin"
git -C "$TMP/origin" symbolic-ref HEAD refs/heads/main
git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit --allow-empty -qm one
git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit --allow-empty -qm two
git clone --quiet "$TMP/origin" "$TMP/clone" 2>/dev/null

# Source the library against the CLONE; keep the fetch marker inside the sandbox.
export COOP_ROOT="$TMP/clone"
export COOP_AGENT_DIR="$TMP/agent"
unset PI_CODING_AGENT_DIR COOP_NO_ISOLATE 2>/dev/null || true
NO_COLOR=1
export NO_COLOR
# shellcheck source=../lib/common.sh
. "$ROOT/lib/common.sh"

# 1. Fresh clone: up to date, no fetch has happened yet.
[ "$(coop_repo_behind_count)" = "0" ] || fail "fresh clone should be 0 behind"
pass "fresh clone reports 0 behind"

# 2. origin gains a commit; the clone's LOCAL origin/main is stale -> still 0.
git -C "$TMP/origin" -c user.email=t@t -c user.name=t commit --allow-empty -qm three
[ "$(coop_repo_behind_count)" = "0" ] || fail "behind-count must be local (no implicit fetch)"
pass "behind-count is purely local (stale origin/main -> 0)"

# 3. The throttled fetch runs (marker absent), refreshes origin/main -> behind=1.
coop_repo_fetch_throttled || fail "first fetch should run (marker absent)"
[ -f "$TMP/agent/.coop-fetch-stamp" ] || fail "fetch should stamp the marker"
[ "$(coop_repo_behind_count)" = "1" ] || fail "after fetch, clone should be 1 behind"
pass "throttled fetch refreshes origin/main (1 behind, marker stamped)"

# 4. A second call within the day is throttled (returns 1) — the once/day gate.
if coop_repo_fetch_throttled; then fail "second fetch within a day must be throttled"; fi
pass "second fetch within a day is throttled"

# 5. The launch nudge warns exactly when it fetches: throttled now -> silent.
out="$(coop_update_nudge 2>&1)" || fail "coop_update_nudge must never fail"
[ -z "$out" ] || fail "throttled nudge must stay silent (got: $out)"
# Age the marker past the throttle window and it fires with the behind-count.
touch -t 202001010000 "$TMP/agent/.coop-fetch-stamp"
out="$(coop_update_nudge 2>&1)" || fail "coop_update_nudge must never fail"
case "$out" in
  *"1 commit(s) behind"*) pass "nudge warns '1 commit(s) behind' after the throttle window" ;;
  *) fail "nudge should warn about being 1 behind (got: $out)" ;;
esac

# 6. Non-git copy: helpers are silent no-ops (0 behind, fetch not applicable).
mkdir -p "$TMP/plain"
COOP_ROOT="$TMP/plain"
[ "$(coop_repo_behind_count)" = "0" ] || fail "non-git copy should report 0 behind"
if coop_repo_fetch_throttled; then fail "non-git copy must not fetch"; fi
out="$(coop_update_nudge 2>&1)" || fail "coop_update_nudge must never fail"
[ -z "$out" ] || fail "non-git nudge must stay silent (got: $out)"
pass "non-git copy: all three helpers are silent no-ops"

printf '  %s\n' "staleness helper tests passed"
