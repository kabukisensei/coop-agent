#!/usr/bin/env bash
#
# H5: step 1 of `coop update` follows release tags and never moves a checkout
# backwards (coop_repo_follow_release / coop_repo_next_release /
# coop_repo_behind_count / coop_repo_stranded / coop_update_nudge in
# lib/common.sh). Gate lane: fully offline (every "origin" is a local bare repo),
# no sleep, no marker, no network. Calls the helpers directly against throwaway
# clones; never runs scripts/update.sh or touches this checkout.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; [ -z "${OUT:-}" ] || printf '%s\n' "$OUT"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

# Hermetic git: no user or system config, a fixed identity.
mkdir -p "$TMP/home"
HOME="$TMP/home"
GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export HOME GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

commit() { # <repo> <message> <file>
  printf '%s\n' "$2" > "$1/$3"
  git -C "$1" add "$3"
  git -C "$1" commit -qm "$2"
}

# The origin: c1 v0.9.0 (annotated) - c2 v0.10.0 (lightweight) - c3 v0.11.0-rc1
# (annotated, never deployed) - c4 (unreleased head of main). A side branch forks
# at c2 with v9.9.9, a tag that contains c1 but is not on main (never deployed).
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
git init -q --bare "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
git init -q "$SEED"
git -C "$SEED" symbolic-ref HEAD refs/heads/main
commit "$SEED" c1 README;  git -C "$SEED" tag -a v0.9.0 -m v0.9.0
commit "$SEED" c2 f2;      git -C "$SEED" tag v0.10.0
commit "$SEED" c3 f3;      git -C "$SEED" tag -a v0.11.0-rc1 -m rc1
commit "$SEED" c4 f4
git -C "$SEED" checkout -q -b side v0.10.0
commit "$SEED" s1 side;    git -C "$SEED" tag -a v9.9.9 -m side
git -C "$SEED" checkout -q main
git -C "$SEED" push -q "$ORIGIN" main side --tags
C1="$(git -C "$SEED" rev-parse 'v0.9.0^{commit}')"
C2="$(git -C "$SEED" rev-parse 'v0.10.0^{commit}')"
C4="$(git -C "$SEED" rev-parse main)"

# Source the library; each case points COOP_ROOT at its own clone.
export COOP_AGENT_DIR="$TMP/agent"
unset PI_CODING_AGENT_DIR COOP_NO_ISOLATE 2>/dev/null || true
NO_COLOR=1
export NO_COLOR
COOP_ROOT="$TMP/unused"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$ROOT/lib/common.sh"

fresh() { # <name> [git clone args...]: clone the origin and point COOP_ROOT at it
  local d="$TMP/$1"; shift
  git clone -q "$@" "$ORIGIN" "$d" >/dev/null 2>&1
  COOP_ROOT="$d"
}
at() { git -C "$COOP_ROOT" rev-parse HEAD; }
branch_ref() { git -C "$COOP_ROOT" symbolic-ref -q HEAD 2>/dev/null || true; }
upstream() { git -C "$COOP_ROOT" rev-parse -q --symbolic-full-name '@{u}' 2>/dev/null || true; }
follow() { OUT="$(coop_repo_follow_release "$1" 2>&1)" || fail "coop_repo_follow_release must return 0"; }

# 1. Downgrade trap: main is ahead of every release; the update keeps it there.
fresh ahead
[ -z "$(coop_repo_next_release)" ] || fail "ahead of every release: next release must be empty"
[ "$(coop_repo_behind_count)" = 0 ] || fail "ahead of every release: behind must be 0"
[ -z "$(coop_repo_stranded)" ] || fail "ahead of every release is not a stranded state"
follow 0
[ "$(at)" = "$C4" ] || fail "a checkout ahead of the newest release was moved"
[ "$(git -C "$COOP_ROOT" rev-parse refs/heads/main)" = "$C4" ] || fail "refs/heads/main moved"
case "$OUT" in *moved*) fail "no move may be announced for a checkout ahead of the newest release" ;; esac
case "$OUT" in *"no newer release to move to"*) ;; *) fail "step 1 should say there is no newer release" ;; esac
# The doctor row and step 1 describe against releases only: never by the rc tag.
case "$(coop_repo_describe)" in v0.10.0-2-g*) ;; *) fail "describe must skip the rc tag (got '$(coop_repo_describe)')" ;; esac
case "$OUT" in *rc1*) fail "step 1 must not describe the checkout by an rc tag" ;; esac
pass "ahead of the newest release: stays put, never moves back (behind 0, no nudge, no rc in describe)"

# 2. Forward move to exactly the next release, never to head. A local branch
#    named like the tag must not hide it (lstrip=2, not :short).
fresh behind
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" branch v0.10.0 "$C2"
[ "$(coop_repo_next_release)" = v0.10.0 ] \
  || fail "at v0.9.0 the next release is v0.10.0: version sort, not rc, not off-main v9.9.9 (got '$(coop_repo_next_release)')"
[ "$(coop_repo_behind_count)" = 1 ] || fail "at v0.9.0 behind should be 1 (got $(coop_repo_behind_count))"
follow 0
[ "$(at)" = "$C2" ] || fail "should land exactly on v0.10.0, not head of main"
[ "$(branch_ref)" = refs/heads/main ] || fail "branch main must stay attached"
[ "$(upstream)" = refs/remotes/origin/main ] || fail "main must keep its origin/main upstream"
case "$OUT" in *"moved from v0.9.0 to release v0.10.0"*) ;; *) fail "step 1 should name the move" ;; esac
# A second run is a no-op and says so: HEAD already on the newest release, and
# the rc tag that contains it is not a release.
[ -z "$(coop_repo_next_release)" ] || fail "on the newest release: next release must be empty (got '$(coop_repo_next_release)')"
[ "$(coop_repo_behind_count)" = 0 ] || fail "on the newest release, unreleased commits on main must read 0 behind"
follow 0
[ "$(at)" = "$C2" ] || fail "a second run must not move (rc tags are not releases)"
case "$OUT" in *moved*) fail "a second run must not announce a move" ;; esac
pass "behind: fast-forwards to exactly v0.10.0 on main (tracking kept); second run is a no-op"

# 2b. A tag named like the branch (a stray 'main' tag, which every fetch
#     auto-follows) must not turn main into a hold in either mode.
fresh tag-main
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" tag main "$C1"
[ -z "$(coop_repo_stranded)" ] || fail "a tag named main must not make main a hold (got: $(coop_repo_stranded))"
[ "$(coop_repo_next_release)" = v0.10.0 ] || fail "a tag named main must not hide the next release"
follow 0
[ "$(at)" = "$C2" ] && [ "$(branch_ref)" = refs/heads/main ] || fail "a tag named main must not stop the release move"
follow 1
[ "$(at)" = "$C4" ] && [ "$(branch_ref)" = refs/heads/main ] || fail "a tag named main must not stop --edge"
pass "a tag named main: main still follows releases, and --edge still pulls"

# 3. A renamed branch that tracks origin/main follows releases too.
fresh renamed
git -C "$COOP_ROOT" branch -q -m main master
git -C "$COOP_ROOT" reset -q --hard v0.9.0
follow 0
[ "$(at)" = "$C2" ] || fail "a renamed branch tracking origin/main should follow releases"
[ "$(branch_ref)" = refs/heads/master ] || fail "the renamed branch must stay attached"
pass "renamed branch tracking origin/main: follows releases (keyed on the upstream, not the name)"

# 4. Dirty: tracked changes skip the move; an unrelated untracked file does not.
fresh dirty
git -C "$COOP_ROOT" reset -q --hard v0.9.0
printf 'local edit\n' >> "$COOP_ROOT/README"
follow 0
case "$OUT" in *uncommitted*) ;; *) fail "a dirty checkout should warn about uncommitted changes" ;; esac
[ "$(at)" = "$C1" ] || fail "a dirty checkout must not move"
git -C "$COOP_ROOT" checkout -q -- README
printf 'stray\n' > "$COOP_ROOT/stray-skill.md"
follow 0
[ "$(at)" = "$C2" ] || fail "an unrelated untracked file must not block the move"
pass "dirty tracked files skip the move; unrelated untracked files do not"

# 5. No source loss: an untracked file where the release adds one blocks the move.
fresh untracked
git -C "$COOP_ROOT" reset -q --hard v0.9.0
printf 'mine\n' > "$COOP_ROOT/f2"
follow 0
[ "$(at)" = "$C1" ] || fail "the move must refuse to overwrite an untracked file"
[ "$(cat "$COOP_ROOT/f2")" = mine ] || fail "the untracked file's content changed"
case "$OUT" in *"could not fast-forward coop-agent to v0.10.0"*) ;; *) fail "a refused move should warn" ;; esac
pass "an untracked file in the way: move refused, file intact, returns 0"

# 6. Detached `clone --branch v0.9.0`: moves forward and stays detached.
fresh detached --branch v0.9.0
[ -z "$(branch_ref)" ] || fail "precondition: clone --branch is detached"
follow 0
[ "$(at)" = "$C2" ] || fail "a detached release checkout should move to v0.10.0"
[ -z "$(branch_ref)" ] || fail "default mode must not re-attach a detached checkout"
git -C "$COOP_ROOT" rev-parse -q --verify refs/heads/main >/dev/null && fail "default mode must not create a local main"
pass "detached release checkout: moves forward to v0.10.0 and stays detached"

# 7. --edge: head of main.
fresh edge-attached
git -C "$COOP_ROOT" reset -q --hard v0.9.0
follow 1
[ "$(at)" = "$C4" ] || fail "--edge on main should pull head of main"
[ "$(branch_ref)" = refs/heads/main ] || fail "--edge must leave main attached"
fresh edge-detached --branch v0.9.0
follow 1
[ "$(at)" = "$C4" ] || fail "--edge from a detached release checkout should land on head of main"
[ "$(branch_ref)" = refs/heads/main ] || fail "--edge should re-attach to main"
[ "$(upstream)" = refs/remotes/origin/main ] || fail "the re-attached main must track origin/main"
fresh edge-stale-main
git -C "$COOP_ROOT" checkout -q --detach v0.10.0
git -C "$COOP_ROOT" branch -f main v0.9.0
follow 1
[ "$(at)" = "$C4" ] && [ "$(branch_ref)" = refs/heads/main ] \
  || fail "--edge should re-attach forward over a local main that is behind origin/main"
pass "--edge: pulls head of main; re-attaches a detached checkout to main at origin/main"

# 7b. --edge guard: a detached commit that is not on origin/main stays put.
fresh edge-local-commit --branch v0.9.0
commit "$COOP_ROOT" local-work local
L="$(at)"
follow 1
[ "$(at)" = "$L" ] && [ -z "$(branch_ref)" ] || fail "--edge must not leave a detached local commit"
case "$OUT" in *"not on origin/main"*) ;; *) fail "--edge should warn about the local commit" ;; esac
# 7c. --edge guard: an existing local main with a commit not on origin/main is
#     never reset by the re-attach (no source loss).
fresh edge-local-main
git -C "$COOP_ROOT" reset -q --hard v0.9.0
commit "$COOP_ROOT" unpushed unpushed
X="$(at)"
git -C "$COOP_ROOT" checkout -q --detach v0.9.0
follow 1
[ "$(git -C "$COOP_ROOT" rev-parse refs/heads/main)" = "$X" ] || fail "--edge reset a local main that had unpushed commits"
[ "$(at)" = "$C1" ] && [ -z "$(branch_ref)" ] || fail "--edge must stay put when local main has unpushed commits"
case "$OUT" in *"local branch main has commits"*) ;; *) fail "--edge should warn about local main" ;; esac
pass "--edge guards: a detached local commit or a local main with unpushed commits stays put"

# 8. Diverged: a local commit on main blocks the next release; step 1 and doctor
#    name it (the nudge stays quiet: behind 0).
fresh diverged
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" branch my-work   # a leftover from an earlier rejoin
commit "$COOP_ROOT" local-work local
L="$(at)"
[ -z "$(coop_repo_next_release)" ] || fail "a diverged checkout has no next release"
[ "$(coop_repo_behind_count)" = 0 ] || fail "a diverged checkout must read 0 behind"
follow 0
[ "$(at)" = "$L" ] || fail "a diverged checkout must not move"
case "$OUT" in *"release v0.10.0 does not contain"*) ;; *) fail "step 1 should name the diverged state" ;; esac
case "$(coop_repo_stranded)" in *"reset --keep v0.10.0"*) ;; *) fail "the stranded state should name the fix" ;; esac
# The printed fix, run as a user pastes it, rejoins the release and keeps the
# local commit on a branch, even with a leftover my-work branch.
S="$(coop_repo_stranded)"
CMD="${S#*set them aside and rejoin: }"
eval "$CMD" >/dev/null 2>&1 || true
[ "$(at)" = "$C2" ] && [ "$(branch_ref)" = refs/heads/main ] || { OUT="$S"; fail "the printed fix should rejoin release v0.10.0 on main"; }
[ -n "$(git -C "$COOP_ROOT" branch --contains "$L")" ] || fail "the printed fix must keep the local commit on a branch"
# If the aside branch cannot be made, the fix must not reset (no orphaned commit).
fresh diverged-collide
git -C "$COOP_ROOT" reset -q --hard v0.9.0
commit "$COOP_ROOT" local-work local
L="$(at)"
S="$(coop_repo_stranded)"
CMD="${S#*set them aside and rejoin: }"
A="${CMD#* branch }"; A="${A%% *}"
git -C "$COOP_ROOT" branch "$A" "$C1"
eval "$CMD" >/dev/null 2>&1 || true
[ "$(at)" = "$L" ] && [ "$(git -C "$COOP_ROOT" rev-parse refs/heads/main)" = "$L" ] \
  || { OUT="$S"; fail "the printed fix reset although its aside branch could not be made"; }
pass "diverged main: no move, behind 0, named; the printed fix rejoins, and never resets without its aside branch"

# 9. Hold: a branch that does not track origin/main is not fetched or moved. Its
#    origin gains a commit after the clone (its own copy, so later cases keep c4).
git clone -q --bare "$ORIGIN" "$TMP/origin-hold.git"
COOP_ROOT="$TMP/hold"
git clone -q "$TMP/origin-hold.git" "$COOP_ROOT"
git -C "$COOP_ROOT" checkout -q -b hold v0.9.0
git clone -q "$TMP/origin-hold.git" "$TMP/hold-writer"
commit "$TMP/hold-writer" c5 f5
git -C "$TMP/hold-writer" push -q origin main
follow 0
[ "$(git -C "$COOP_ROOT" rev-parse refs/remotes/origin/main)" = "$C4" ] || fail "a hold must not be fetched"
[ "$(at)" = "$C1" ] || fail "a hold must not move"
[ "$(coop_repo_behind_count)" = 0 ] || fail "a hold reads 0 behind"
case "$OUT" in *"held on branch 'hold'"*"switch main"*) ;; *) fail "step 1 should name the hold and how to rejoin" ;; esac
follow 1
[ "$(at)" = "$C1" ] || fail "--edge has nothing to pull on a hold with no upstream"
case "$OUT" in *"held on branch 'hold'"*) ;; *) fail "--edge on a hold with no upstream should name the hold" ;; esac
fresh non-tracking
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" branch --unset-upstream
follow 0
[ "$(at)" = "$C1" ] || fail "a main that does not track origin/main is a hold"
case "$OUT" in *"branch --set-upstream-to=origin/main main"*) ;; *) fail "a non-tracking main should name the fix" ;; esac
pass "hold branch (no upstream, or not origin/main): not fetched, not moved, named with the fix"

# 9b. Keyed on the upstream being origin/main, not on having one: the usual hold
#     (`git switch pinned`, which tracks origin/pinned) and a main that tracks
#     another remote's main are holds. Default mode neither fetches nor moves
#     them; --edge pulls the hold's own upstream.
git -C "$TMP/hold-writer" push -q origin "$C1:refs/heads/pinned"
COOP_ROOT="$TMP/pinned"
git clone -q "$TMP/origin-hold.git" "$COOP_ROOT"
git -C "$COOP_ROOT" checkout -q -b pinned --track origin/pinned
git -C "$TMP/hold-writer" checkout -q -b pinned "$C1"
commit "$TMP/hold-writer" p2 fp
git -C "$TMP/hold-writer" push -q origin pinned
P2="$(git -C "$TMP/hold-writer" rev-parse HEAD)"
follow 0
[ "$(at)" = "$C1" ] || fail "a branch tracking origin/pinned is a hold: default mode must not move it"
[ "$(git -C "$COOP_ROOT" rev-parse refs/remotes/origin/pinned)" = "$C1" ] || fail "a hold with an upstream must not be fetched"
case "$OUT" in *"held on branch 'pinned'"*) ;; *) fail "step 1 should name the pinned hold" ;; esac
follow 1
[ "$(at)" = "$P2" ] && [ "$(branch_ref)" = refs/heads/pinned ] || fail "--edge should pull a hold's own upstream"
fresh fork-main
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" remote add fork "$ORIGIN"
git -C "$COOP_ROOT" fetch -q fork
git -C "$COOP_ROOT" branch -q --set-upstream-to=fork/main >/dev/null
follow 0
[ "$(at)" = "$C1" ] || fail "a main that tracks fork/main is a hold"
case "$OUT" in *"held on branch 'main'"*"set-upstream-to=origin/main main"*) ;; *) fail "a main tracking fork/main should be named with the fix" ;; esac
pass "hold tracking origin/pinned or fork/main: not fetched, not moved; --edge pulls its own upstream"

# 10. Offline: a failed fetch warns, returns 0, and still moves on known tags.
fresh offline
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" remote set-url origin "$TMP/missing.git"
follow 0
case "$OUT" in *"could not fetch from origin"*) ;; *) fail "a failed fetch should warn" ;; esac
[ "$(at)" = "$C2" ] || fail "offline, the move should use the releases already fetched"
pass "offline: warns, returns 0, moves to a release it already knows"

# 11. A tag-only shallow clone has no origin/main: named, and the named fix works.
ORIGIN_URL="file://$ORIGIN"
if command -v cygpath >/dev/null 2>&1; then ORIGIN_URL="file:///$(cygpath -m "$ORIGIN")"; fi
COOP_ROOT="$TMP/shallow"
git clone -q --depth 1 --branch v0.9.0 "$ORIGIN_URL" "$COOP_ROOT" >/dev/null 2>&1
follow 0
[ "$(at)" = "$C1" ] || fail "a tag-only clone cannot move"
case "$OUT" in *"no origin/main to follow"*"remote set-branches origin '*'"*) ;; *) fail "step 1 should name the missing origin/main and the fix" ;; esac
git -C "$COOP_ROOT" remote set-branches origin '*'
git -C "$COOP_ROOT" fetch -q origin
follow 0
[ "$(at)" = "$C2" ] || fail "after the named fix the clone should follow releases"
pass "tag-only shallow clone: no origin/main is named; the named fix makes it follow releases"

# 12. An always-succeed git stub (junk output) reads as nothing to do.
mkdir -p "$TMP/stub"
printf '#!/bin/sh\necho "git version 2.50.0"\nexit 0\n' > "$TMP/stub/git"
chmod +x "$TMP/stub/git"
fresh stubbed
(
  PATH="$TMP/stub:$PATH"
  [ -z "$(coop_repo_next_release)" ] || fail "a git stub must give no next release"
  [ -z "$(coop_repo_describe)" ] || fail "a git stub must give no describe"
  [ "$(coop_repo_behind_count)" = 0 ] || fail "a git stub must give 0 behind"
)
pass "junk git output: no next release, no describe, 0 behind"

# 13. The launch nudge counts against the next release only (the daily fetch is
#     stubbed out here; tests/staleness.test.sh covers the throttle).
(
  coop_repo_fetch_throttled() { return 0; }
  fresh nudge-current
  git -C "$COOP_ROOT" reset -q --hard v0.10.0
  out="$(coop_update_nudge 2>&1)" || fail "coop_update_nudge must never fail"
  [ -z "$out" ] || fail "on the newest release, unreleased commits on main must not nudge (got: $out)"
  fresh nudge-behind
  git -C "$COOP_ROOT" reset -q --hard v0.9.0
  out="$(coop_update_nudge 2>&1)" || fail "coop_update_nudge must never fail"
  case "$out" in *"1 commit(s) behind release v0.10.0"*) ;; *) fail "nudge should name the release (got: $out)" ;; esac
)
pass "launch nudge: silent on the newest release despite unreleased main, names the release when behind"

# 14. A new release on origin is picked up by the plain fetch and followed.
git clone -q --bare "$ORIGIN" "$TMP/origin-new.git"
COOP_ROOT="$TMP/new-release"
git clone -q "$TMP/origin-new.git" "$COOP_ROOT"
git -C "$COOP_ROOT" reset -q --hard v0.10.0
git -C "$SEED" tag -a v0.12.0 -m v0.12.0 "$C4"
git -C "$SEED" push -q "$TMP/origin-new.git" v0.12.0
follow 0
[ "$(at)" = "$C4" ] || fail "a release tagged after the clone should be fetched and followed"
case "$OUT" in *"to release v0.12.0"*) ;; *) fail "step 1 should name v0.12.0" ;; esac
pass "a release tagged after the clone: plain fetch brings it, update moves to it"

# 14b. No origin remote (renamed or removed) is named as such, not as a hold,
#      with a fix that works when run as printed.
fresh renamed-remote
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" remote rename origin upstream
S="$(coop_repo_stranded)"
case "$S" in "coop-agent has no origin remote"*"remote rename upstream origin") ;; *) OUT="$S"; fail "a renamed origin should be named with the rename fix" ;; esac
eval "${S#*fix: }" || { OUT="$S"; fail "the printed rename fix should run"; }
[ -z "$(coop_repo_stranded)" ] || fail "after the printed rename fix the checkout is not stranded"
follow 0
[ "$(at)" = "$C2" ] || fail "after the printed rename fix the checkout should follow releases"
fresh removed-remote
git -C "$COOP_ROOT" reset -q --hard v0.9.0
git -C "$COOP_ROOT" remote remove origin
S="$(coop_repo_stranded)"
U=https://github.com/kabukisensei/coop-agent.git
case "$S" in "coop-agent has no origin remote"*"remote add origin $U"*) ;; *) OUT="$S"; fail "a removed origin should be named with the add fix" ;; esac
# Offline stand-in for the canonical URL: the add fix, then the fix it leads to.
CMD="${S#*fix: }"
eval "${CMD/$U/$ORIGIN}" >/dev/null 2>&1 || { OUT="$S"; fail "the printed add fix should run"; }
S="$(coop_repo_stranded)"
eval "${S#*again: }" >/dev/null 2>&1 || { OUT="$S"; fail "the follow-up fix should run"; }
follow 0
[ "$(at)" = "$C2" ] || fail "after the printed fixes the checkout should follow releases"
pass "no origin remote (renamed or removed): named, and the printed fix restores release following"

# 15. Wiring: step 1 and the doctor row call these helpers in both twins.
OUT=""
grep -qF 'coop_repo_follow_release "$EDGE"' "$ROOT/scripts/update.sh" || fail "update.sh step 1 must call coop_repo_follow_release"
grep -qF 'Invoke-CoopRepoFollowRelease $EDGE' "$ROOT/scripts/update.ps1" || fail "update.ps1 step 1 must call Invoke-CoopRepoFollowRelease"
if grep -n 'pull --ff-only' "$ROOT/scripts/update.sh" "$ROOT/scripts/update.ps1"; then
  fail "update.* must not pull the repo directly (the pull lives in lib/common.*)"
fi
grep -qF '_coop_repo_warn_stranded || coop_warn' "$ROOT/scripts/update.sh" || fail "update.sh step 1 must name a missing origin with its fix"
grep -qF 'if (-not (Write-CoopRepoStranded)) { Coop-Warn' "$ROOT/scripts/update.ps1" || fail "update.ps1 step 1 must name a missing origin with its fix"
grep -qF 'coop_repo_stranded' "$ROOT/scripts/doctor.sh" || fail "doctor.sh must name stranded states"
grep -qF 'Get-CoopRepoStranded' "$ROOT/scripts/doctor.ps1" || fail "doctor.ps1 must name stranded states"
pass "update.* step 1 and doctor.* call the shared helpers"

printf '  %s\n' "update-follow tests passed"
