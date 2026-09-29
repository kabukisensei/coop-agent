#!/usr/bin/env bash
#
# #108: `coop version` and `coop doctor --publish` carry the checkout's
# `git describe` (coop_repo_describe), so two machines on different commits past
# the same release tag are told apart, in the version report and in the fleet
# digest. A copy that is not a git checkout prints VERSION only, with no error.
# Offline and hermetic: every checkout is a copy of a seed repo built from a copy
# of this tree (never the checkout running the tests, #104) with no origin, so
# doctor has nothing to fetch; HOME, COOP_DIR, the agent dir and the publish dir
# are temp dirs, and pi/npm/pipx/az/fab/brew/winget are stubs. No sleep.
# PowerShell twin: tests/fixtures/version-describe.test.ps1.
#
set -euo pipefail

CHECKOUT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; [ -z "${OUT:-}" ] || printf '%s\n' "$OUT"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

# Stubs first on PATH; the real git, python and node sit behind exec wrappers
# (Git Bash keeps them off /usr/bin).
STUB="$TMP/stub"; mkdir -p "$STUB"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo 0.84.3; exit 0; }\nexit 0\n' > "$STUB/pi"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo 10.9.0; exit 0; }\nexit 0\n' > "$STUB/npm"
for t in pipx az fab brew winget; do printf '#!/bin/sh\nexit 1\n' > "$STUB/$t"; done
for t in git node; do printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v "$t")" > "$STUB/$t"; done
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v python3 || command -v python)" > "$STUB/python3"
chmod +x "$STUB"/*

mkdir -p "$TMP/home/.coop" "$TMP/agent" "$TMP/published" "$TMP/cwd"
HOME="$TMP/home"; COOP_DIR="$TMP/home"; USERPROFILE="$TMP/home"
COOP_AGENT_DIR="$TMP/agent"; PI_CODING_AGENT_DIR="$TMP/agent"
PIPX_HOME="$TMP/pipx-home"; PIPX_BIN_DIR="$TMP/pipx-bin"; npm_config_prefix="$TMP/npm-prefix"
COOP_TEST_STUB_PATH="$STUB"; COOP_SKIP_AZ=1; COOP_NO_ONBOARD=1; NO_COLOR=1
PATH="$STUB:/usr/bin:/bin"
GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export HOME COOP_DIR USERPROFILE COOP_AGENT_DIR PI_CODING_AGENT_DIR PIPX_HOME PIPX_BIN_DIR \
  npm_config_prefix COOP_TEST_STUB_PATH COOP_SKIP_AZ COOP_NO_ONBOARD NO_COLOR PATH \
  GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
unset COOP_ROOT COOP_NO_ISOLATE COOP_RELEASE_MANIFEST 2>/dev/null || true
# doctor --publish writes here, never to a shared folder.
printf 'fleet:\n  publish_dir: %s\n' "$TMP/published" > "$HOME/.coop/config"

# The release history: c1 tagged v0.23.5 (VERSION 0.23.5), then c2 and c3.
SEED="$TMP/seed"; mkdir "$SEED"
cp -R "$CHECKOUT"/* "$CHECKOUT/.coop" "$SEED/"
printf '0.23.5\n' > "$SEED/VERSION"
git init -q "$SEED"
git -C "$SEED" add -A
git -C "$SEED" commit -qm c1
git -C "$SEED" tag -a v0.23.5 -m v0.23.5
for c in c2 c3; do
  printf '%s\n' "$c" > "$SEED/$c.txt"
  git -C "$SEED" add "$c.txt"
  git -C "$SEED" commit -qm "$c"
done

# Machine A runs c2 (one past the tag), machine B runs c3 (two past it). Each is
# a copy of the seed repo, not a clone: a local clone runs git-upload-pack from
# PATH, and Git Bash keeps it in /mingw64, off this fixture's PATH. A copy has no
# origin, so doctor has nothing to fetch.
machine() { # <name> <commit-ish>
  local d="$TMP/$1/coop-agent"
  mkdir -p "$TMP/$1"
  cp -R "$SEED" "$d"
  git -C "$d" reset -q --hard "$2"
}
machine a HEAD~1
machine b HEAD
A="$TMP/a/coop-agent"; B="$TMP/b/coop-agent"
DESC_A="v0.23.5-1-g$(git -C "$A" rev-parse --short HEAD)"
DESC_B="v0.23.5-2-g$(git -C "$B" rev-parse --short HEAD)"

version_of() { # <root>: `coop version` from that copy; stderr to $TMP/version.err
  OUT="$(cd "$TMP/cwd" && bash "$1/bin/coop" version 2>"$TMP/version.err")" \
    || fail "coop version exited non-zero in $1"
}

# 1. Two machines past the same tag print different, exact version lines.
version_of "$A"; OUT_A="$OUT"
[ "$(printf '%s\n' "$OUT_A" | sed -n 1p)" = "coop 0.23.5 ($DESC_A)" ] \
  || fail "coop version on machine A must read 'coop 0.23.5 ($DESC_A)'"
[ "$(printf '%s\n' "$OUT_A" | sed -n 2p)" = "pi   0.84.3" ] || fail "coop version must still print the pi line"
version_of "$B"; OUT_B="$OUT"
[ "$(printf '%s\n' "$OUT_B" | sed -n 1p)" = "coop 0.23.5 ($DESC_B)" ] \
  || fail "coop version on machine B must read 'coop 0.23.5 ($DESC_B)'"
[ "$OUT_A" != "$OUT_B" ] || fail "two commits past the same tag must print different coop version output"
pass "coop version names the commit: $DESC_A vs $DESC_B past the same v0.23.5"

# 2. A copy that is not a git checkout prints VERSION only, with no error, even
#    inside another repository whose tags must not be borrowed.
OUTER="$TMP/outer"
git init -q "$OUTER"
printf 'x\n' > "$OUTER/x"; git -C "$OUTER" add x; git -C "$OUTER" commit -qm outer
git -C "$OUTER" tag v9.9.9
mkdir "$OUTER/coop-agent"
cp -R "$SEED"/* "$SEED/.coop" "$OUTER/coop-agent/"
version_of "$OUTER/coop-agent"
[ "$(printf '%s\n' "$OUT" | sed -n 1p)" = "coop 0.23.5" ] \
  || fail "a non-git copy must print 'coop 0.23.5' and nothing else on the coop line"
[ ! -s "$TMP/version.err" ] || { OUT="$(cat "$TMP/version.err")"; fail "a non-git copy must print no error"; }
pass "a non-git copy prints VERSION only, with no error (and never the enclosing repo's tag)"

# 3. doctor --publish carries coop_describe; the digest tells the machines apart.
#    doctor.sh's publish step embeds POSIX paths in the Python it runs, which a
#    native Windows Python under Git Bash cannot resolve; Windows publishes
#    through doctor.ps1, which tests/fixtures/version-describe.test.ps1 covers.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    printf '  – doctor.sh --publish and the digest: POSIX only here; doctor.ps1 is covered by the PowerShell fixture\n'
    printf '  %s\n' "version-describe tests passed"
    exit 0 ;;
esac
publish() { # <root> <user>
  local user="$2" out="$TMP/doctor-$2.out"
  ( cd "$TMP/cwd" && USER="$user" bash "$1/scripts/doctor.sh" --publish >"$out" 2>&1 ) || true
  set -- "$TMP"/published/*_"$user".json
  [ -f "$1" ] || { OUT="$(cat "$out")"; fail "doctor --publish wrote no snapshot for $user"; }
  PUBLISHED="$1"
}
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2], "<absent>"))' "$1" "$2"; }
publish "$A" alice
[ "$(field "$PUBLISHED" coop_describe)" = "$DESC_A" ] \
  || { OUT="$(cat "$PUBLISHED")"; fail "machine A's snapshot must carry coop_describe $DESC_A"; }
[ "$(field "$PUBLISHED" coop_version)" = 0.23.5 ] || { OUT="$(cat "$PUBLISHED")"; fail "coop_version must stay VERSION"; }
publish "$B" bob
[ "$(field "$PUBLISHED" coop_describe)" = "$DESC_B" ] \
  || { OUT="$(cat "$PUBLISHED")"; fail "machine B's snapshot must carry coop_describe $DESC_B"; }
publish "$OUTER/coop-agent" dana
[ "$(field "$PUBLISHED" coop_describe)" = "" ] \
  || { OUT="$(cat "$PUBLISHED")"; fail "a non-git copy's snapshot must carry an empty coop_describe"; }
pass "doctor --publish adds coop_describe next to coop_version ('' for a non-git copy)"

# A snapshot from a coop that predates coop_describe renders VERSION alone.
printf '{"hostname":"older","user":"carol","coop_version":"0.23.4","pi_version":"0.84.3","fail":0,"warn":0,"checks":[]}\n' \
  > "$TMP/published/older_carol.json"
printf 'fleet:\n  publish_dir: %s\n' "$TMP/published" > "$TMP/digest-config"
for fmt in md html; do
  OUT="$(python3 "$CHECKOUT/scripts/fleet-digest.py" --config "$TMP/digest-config" --format "$fmt")" \
    || fail "fleet-digest --format $fmt failed"
  case "$OUT" in *"coop 0.23.5 ($DESC_A)"*) ;; *) fail "the $fmt digest must show machine A as coop 0.23.5 ($DESC_A)" ;; esac
  case "$OUT" in *"coop 0.23.5 ($DESC_B)"*) ;; *) fail "the $fmt digest must show machine B as coop 0.23.5 ($DESC_B)" ;; esac
  if [ "$fmt" = md ]; then older="coop 0.23.4, pi"; else older="coop 0.23.4<br>pi"; fi
  case "$OUT" in *"$older"*) ;; *) fail "the $fmt digest must show a snapshot without coop_describe as '$older'" ;; esac
done
pass "fleet-digest (md and html) tells the two machines apart and still renders older snapshots"

printf '  %s\n' "version-describe tests passed"
