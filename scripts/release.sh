#!/usr/bin/env bash
#
# release.sh — tag a coop-agent release (maintainers; Aaron runs this on his Mac).
#
#   ./bin/coop release [--yes] [--no-check]
#   bash scripts/release.sh ...            (same thing)
#
# The version bump is a pull request first (.github/workflows/release-pr.yml, or
# `bash scripts/bump-version.sh` by hand): it moves VERSION, the manifest, the
# extension manifests and CHANGELOG.md, and CI runs the gate lane on it (and the
# extended lane: extended.yml runs on a PR that changes VERSION). Once that PR
# has merged, this command verifies and tags: a clean tree on an attached main
# that equals origin/main; VERSION, the manifest and every extension at the same
# X.Y.Z with a CHANGELOG section for it and no vX.Y.Z tag yet; GitHub CI complete
# and green on the exact commit; the manifest's coop-tool pins against the
# sibling coop-website's versions.json; the bundled standards at the wiki's
# head. Then it tags vX.Y.Z and pushes the tag, which runs release.yml (the
# installer acceptance, the GitHub Release, the coop-website sync PR). Runbook:
# RELEASE.md.
#
# This is the one maintainer command that stays in bash after master plan S1
# (the product runs in PowerShell: bin/coop.ps1); it is dev tooling, not a
# product path. Self-contained: the few helpers it uses are defined below.
set -euo pipefail

_src="${BASH_SOURCE[0]}"
while [ -h "$_src" ]; do
  _dir="$(cd -P "$(dirname "$_src")" >/dev/null 2>&1 && pwd)"
  _src="$(readlink "$_src")"
  case "$_src" in /*) ;; *) _src="$_dir/$_src" ;; esac
done
COOP_ROOT="${COOP_ROOT:-$(cd -P "$(dirname "$_src")/.." >/dev/null 2>&1 && pwd)}"
export COOP_ROOT

# --- Minimal helpers (plain glyphs; colour only on a TTY) --------------------
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  COOP_RST=$'\033[0m'; COOP_RED=$'\033[31m'; COOP_FOREST=$'\033[32m'; COOP_OLIVE=$'\033[33m'; COOP_LIME=$'\033[92m'
else
  COOP_RST=''; COOP_RED=''; COOP_FOREST=''; COOP_OLIVE=''; COOP_LIME=''
fi
coop_info() { printf '%s•%s %s\n' "$COOP_LIME"   "$COOP_RST" "$*" >&2; }
coop_ok()   { printf '%s✓%s %s\n' "$COOP_FOREST" "$COOP_RST" "$*" >&2; }
coop_warn() { printf '%s!%s %s\n' "$COOP_OLIVE"  "$COOP_RST" "$1${2:+ — $2}" >&2; }
coop_err()  { printf '%s✗%s %s\n' "$COOP_RED"    "$COOP_RST" "$*" >&2; }
coop_die()  { coop_err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
coop_confirm() {
  local prompt="${1:-Proceed?}"
  if [ "${COOP_ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then coop_warn "Non-interactive shell; refusing without --yes."; return 1; fi
  printf '%s%s%s [y/N] ' "$COOP_OLIVE" "$prompt" "$COOP_RST" >&2
  local ans; read -r ans
  case "$ans" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}
_coop_repo_branch() {
  local ref
  ref="$(git -C "$COOP_ROOT" symbolic-ref -q HEAD 2>/dev/null || true)"
  case "$ref" in refs/heads/?*) printf '%s' "${ref#refs/heads/}" ;; esac
  return 0
}

# --- Release gate: the manifest's coop-tool pins vs coop-website/versions.json -
# config/release-manifest.json (python_tools) pins the coop-tool versions a
# release installs; the sibling coop-website checkout's versions.json is the
# suite's single source of truth for released version strings. Verify the three
# pins BEFORE tagging so they can't drift releases-stale again (issue #23):
#   - pins match versions.json      -> ok, continue
#   - a pin disagrees / unreadable  -> die (fix the manifest, or --no-check)
#   - sibling checkout missing      -> warn + confirm (offline / partial clones
#                                      stay workable; --yes continues with a note)
# Returns 1 when the user declines the confirm (caller cancels the release).
coop_release_check_pins() {
  local assume_yes="${1:-0}"
  local manifest="$COOP_ROOT/config/release-manifest.json"
  local vjson="$COOP_ROOT/../coop-website/versions.json"
  if [ ! -f "$vjson" ]; then
    coop_warn "sibling coop-website checkout not found — can't verify config/release-manifest.json python_tools against versions.json (see RELEASE.md)."
    if [ "$assume_yes" = "1" ]; then
      coop_info "continuing (--yes) — verify the coop-tool pins by hand."
      return 0
    fi
    coop_confirm "Release without verifying the coop-tool pins?" || return 1
    return 0
  fi
  local tool pin rel mismatch=0
  # The pipx-published Coop tools the manifest pins (coop-data-doc and, since
  # SQ10, coop-schema-compare; the reviewers left in ST1).
  local pin_tools="coop-data-doc coop-schema-compare coop-sql-source-control"
  # shellcheck disable=SC2086
  for tool in $pin_tools; do
    # Both files keep a one-`"key": "value"`-per-line layout (the manifest is
    # pretty-printed JSON; versions.json's is enforced by coop-website's own
    # checker), so sed is safe — and python-free — here.
    pin="$(sed -n 's/^[[:space:]]*"'"$tool"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")"; pin="${pin%%$'\n'*}"
    rel="$(sed -n 's/^[[:space:]]*"'"$tool"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$vjson")"; rel="${rel%%$'\n'*}"
    if [ -z "$rel" ]; then
      coop_warn "could not read $tool from coop-website/versions.json — skipping its pin check."
      continue
    fi
    if [ -z "$pin" ]; then
      coop_warn "could not read python_tools.$tool from config/release-manifest.json (versions.json says $tool is $rel)."
      mismatch=1
    elif [ "$pin" != "$rel" ]; then
      coop_warn "python_tools.$tool is $pin in config/release-manifest.json but coop-website/versions.json says $rel."
      mismatch=1
    fi
  done
  if [ "$mismatch" = "1" ]; then
    coop_die "the coop-tool pins in config/release-manifest.json disagree with coop-website/versions.json — update the manifest (see RELEASE.md), or re-run with --no-check."
  fi
  coop_ok "coop-tool pins match coop-website/versions.json"
}

# --- Release gate: the bundled standards copy is the wiki's current main --------
# config/standards-bundle/bundle.json records the cooptimize/coop-standards
# revision the bundle was captured from; first runs and offline machines read
# that copy until `coop sync` reaches the wiki. RELEASE.md asks for a refresh
# before every release, and bundle-check only proves the bundle is internally
# consistent, so a missed refresh shipped October's rules at an older revision
# (issue #434). Compare the bundle's revision with the wiki's branch head BEFORE
# tagging:
#   - same revision             -> ok, continue
#   - a different revision      -> die (bundle-update, or --no-check)
#   - wiki unreachable/unknown  -> warn + confirm (--yes continues with a note)
# Returns 1 when the user declines the confirm (caller cancels the release).
coop_release_bundle_field() { # <field> -> the string value in bundle.json (one key per line)
  sed -n 's/^[[:space:]]*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$COOP_ROOT/config/standards-bundle/bundle.json" | head -n 1
}
coop_release_wiki_head() { # <repository> <branch> -> the branch head's sha, or '' when unreachable
  local out
  out="$(git ls-remote --heads "$1" "refs/heads/$2" 2>/dev/null)" || return 1
  printf '%s' "${out%%[[:space:]]*}"
}
coop_release_check_bundle() {
  local assume_yes="${1:-0}"
  local bundle="$COOP_ROOT/config/standards-bundle/bundle.json"
  local repository branch revision head
  repository="$(coop_release_bundle_field repository)"; branch="$(coop_release_bundle_field branch)"; revision="$(coop_release_bundle_field revision)"
  if [ ! -f "$bundle" ] || [ -z "$repository" ] || [ -z "$branch" ] || [ -z "$revision" ]; then
    coop_die "config/standards-bundle/bundle.json is missing or unreadable — refresh it (node lib/standards-cli.mjs bundle-update <clone>, see RELEASE.md), or re-run with --no-check."
  fi
  head="$(coop_release_wiki_head "$repository" "$branch")" || head=""
  if [ -z "$head" ]; then
    coop_warn "could not read $branch of $repository — can't verify that config/standards-bundle (wiki @ ${revision:0:7}) is current (see RELEASE.md)."
    if [ "$assume_yes" = "1" ]; then
      coop_info "continuing (--yes) — verify the bundled standards by hand."
      return 0
    fi
    coop_confirm "Release without verifying the bundled standards?" || return 1
    return 0
  fi
  if [ "$head" != "$revision" ]; then
    coop_die "config/standards-bundle is the wiki @ ${revision:0:7} but $branch of $repository is at ${head:0:7} — refresh it (node lib/standards-cli.mjs bundle-update <clean clone>, then bundle-check; see RELEASE.md), or re-run with --no-check."
  fi
  coop_ok "bundled standards are the wiki's current $branch (${revision:0:7})"
}

# --- Release gate: CI green on the commit being tagged -------------------------
# The release PR ran the suites on these bytes (ci.yml's gate lane, and
# extended.yml on a PR that changes VERSION); the merge commit on main ran
# ci.yml again with the push-to-main installer upgrade acceptance. So the tag
# needs no local test run: GitHub's check runs for the exact commit (HEAD ==
# origin/main, checked earlier) must be complete and green. Still running, red,
# no runs, or GitHub unreachable fail closed (--no-check is the explicit opt-out).

# Prints the GitHub "owner/repo" of origin, or nothing.
coop_release_github_repo() {
  local url
  url="$(git -C "$COOP_ROOT" remote get-url origin 2>/dev/null || true)"
  case "$url" in
    https://github.com/*) url="${url#https://github.com/}" ;;
    git@github.com:*)     url="${url#git@github.com:}" ;;
    ssh://git@github.com/*) url="${url#ssh://git@github.com/}" ;;
    *) return 0 ;;
  esac
  url="${url%/}"; url="${url%.git}"
  printf '%s' "$url"
}

# coop_release_ci_verdict <sha>: prints one line —
#   green <n>          every check run on the commit completed successfully
#   running <names>    at least one check run is queued or in progress
#   red <names>        at least one completed check run did not succeed
#   none               GitHub knows no check runs for the commit
#   unreachable <why>  the API could not be read (no gh/curl, offline, bad JSON)
# COOP_RELEASE_CHECKS_JSON=<file> reads a saved check-runs response instead
# (tests). gh is preferred (it carries the user's login); curl works for the
# public repo without one.
coop_release_ci_verdict() {
  local sha="$1" repo json
  if [ -n "${COOP_RELEASE_CHECKS_JSON:-}" ]; then
    json="$(cat "$COOP_RELEASE_CHECKS_JSON" 2>/dev/null)" || { printf 'unreachable %s\n' "cannot read $COOP_RELEASE_CHECKS_JSON"; return 0; }
  else
    repo="$(coop_release_github_repo)"
    [ -n "$repo" ] || { printf 'unreachable %s\n' "origin is not a github.com remote"; return 0; }
    local path="repos/$repo/commits/$sha/check-runs?per_page=100"
    # gh first (a signed-in gh carries the user's rate limit); a gh that is not
    # signed in refuses even public reads, so fall through to plain curl, which
    # reads a public repo without any login.
    local err=""
    json=""
    if have gh; then
      json="$(gh api "$path" 2>/dev/null)" || json=""
    fi
    if [ -z "$json" ]; then
      if have curl; then
        json="$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/$path" 2>&1)" \
          || { err="${json%%$'\n'*}"; printf 'unreachable %s\n' "curl failed: ${err:-no response}"; return 0; }
      else
        printf 'unreachable %s\n' "neither a signed-in gh nor curl can read GitHub here"; return 0
      fi
    fi
  fi
  local py=python3; have python3 || py=python
  printf '%s' "$json" | "$py" -I -c '
import json, sys
try:
    runs = json.load(sys.stdin).get("check_runs", [])
except Exception as e:
    print("unreachable the check-runs response is not JSON (%s)" % e); sys.exit(0)
if not runs:
    print("none"); sys.exit(0)
red, running = [], []
for r in runs:
    name = r.get("name") or "?"
    if r.get("status") != "completed":
        running.append(name)
    elif r.get("conclusion") not in ("success", "skipped", "neutral"):
        red.append("%s (%s)" % (name, r.get("conclusion")))
if red:
    print("red " + ", ".join(red))
elif running:
    print("running " + ", ".join(running))
else:
    print("green %d" % len(runs))
' 2>/dev/null || printf 'unreachable %s\n' "$py could not parse the check-runs response"
}

# --- Release gate: an attached main that equals origin/main (#105) ------------
# `coop update` follows only tags merged into origin/main (H5), so a tag cut from
# a detached HEAD, another branch, or a main with unpushed or missing commits
# never deploys: the fleet ignores it silently. Fetches origin, then dies with the
# fix unless HEAD is the branch main and points at origin/main. Runs before any
# file changes; the atomic push in coop_release covers origin moving afterwards.
coop_release_require_main() {
  local branch err line here there counts ahead behind
  branch="$(_coop_repo_branch)"
  [ -n "$branch" ] || coop_die "HEAD is detached — release from main: git switch main && git pull --ff-only"
  [ "$branch" = "main" ] || coop_die "on branch '$branch' — release from main: git switch main && git pull --ff-only"
  if ! err="$(git -C "$COOP_ROOT" fetch --quiet origin 2>&1 >/dev/null)"; then
    IFS= read -r line <<<"$err" || true
    coop_die "could not fetch origin (git: ${line:-fetch failed}) — a release must start from the current origin/main; fix the remote or network and re-run."
  fi
  there="$(git -C "$COOP_ROOT" rev-parse -q --verify 'refs/remotes/origin/main' 2>/dev/null || true)"
  [ -n "$there" ] || coop_die "no origin/main after fetching origin — a release tags origin/main; check the origin remote."
  here="$(git -C "$COOP_ROOT" rev-parse -q --verify HEAD 2>/dev/null || true)"
  if [ "$here" != "$there" ]; then
    counts="$(git -C "$COOP_ROOT" rev-list --left-right --count "HEAD...refs/remotes/origin/main" 2>/dev/null || true)"
    read -r ahead behind <<<"$counts" || true
    coop_die "main differs from origin/main (${ahead:-?} ahead, ${behind:-?} behind) — a release tags exactly origin/main: land or drop local commits, git pull --ff-only, then re-run."
  fi
  coop_ok "on main at origin/main"
}

# --- Release gate: VERSION, the manifests and the CHANGELOG agree on one X.Y.Z --
# coop_release_check_tree: prints the version when VERSION is X.Y.Z, the manifest's
# coop_version and every extensions/*/package.json carry the same value and
# CHANGELOG.md has a "## [X.Y.Z]" section; dies otherwise, naming the release PR
# as the fix (the bump is never done here).
coop_release_check_tree() {
  local cur manifest manifest_cur f ext_ver
  [ -f "$COOP_ROOT/VERSION" ] || coop_die "VERSION file missing at $COOP_ROOT/VERSION — fix it before releasing."
  cur="$(tr -d '[:space:]' < "$COOP_ROOT/VERSION" 2>/dev/null || true)"
  case "$cur" in
    ''|*[!0-9.]*|.*|*.|*..*|*.*.*.*) coop_die "VERSION ('$cur') is not X.Y.Z — fix it before releasing." ;;
  esac
  manifest="$COOP_ROOT/config/release-manifest.json"
  [ -f "$manifest" ] || coop_die "release manifest missing at $manifest — fix it before releasing."
  manifest_cur="$(sed -n 's/^[[:space:]]*"coop_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")"
  [ "$manifest_cur" = "$cur" ] \
    || coop_die "release manifest coop_version ('$manifest_cur') does not match VERSION ('$cur') — the release PR (scripts/bump-version.sh) moves both; merge it first."
  for f in "$COOP_ROOT"/extensions/*/package.json; do
    [ -f "$f" ] || continue
    ext_ver="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -n 1)"
    [ "$ext_ver" = "$cur" ] \
      || coop_die "${f#"$COOP_ROOT"/} is at '$ext_ver', VERSION is $cur — the release PR (scripts/bump-version.sh) moves every extension; merge it first."
  done
  grep -q "^## \[$cur\]" "$COOP_ROOT/CHANGELOG.md" 2>/dev/null \
    || coop_die "CHANGELOG.md has no '## [$cur]' section — the release PR (scripts/bump-version.sh) rolls [Unreleased] into it; merge it first."
  printf '%s' "$cur"
}

# --- Release: verify, then tag and push the tag ---------------------------------
coop_release() {
  local assume_yes=0 do_check=1
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -y|--yes)          assume_yes=1 ;;
      --check)           do_check=1 ;;
      --no-check)        do_check=0 ;;
      patch|minor|major) coop_die "the version bump is a pull request now: Actions -> release-pr -> Run workflow ($1), or bash scripts/bump-version.sh $1 and open the PR; after it merges, run coop release to tag." ;;
      -h|--help)
        cat >&2 <<'EOF'
Usage: coop release [--yes] [--no-check]
  Tag the release the merged release PR prepared: verifies a clean main at
  origin/main whose VERSION, manifests and CHANGELOG agree on one X.Y.Z with no
  such tag yet, that GitHub CI is complete and green on this exact commit, that
  the manifest's coop-tool pins match the sibling coop-website's versions.json
  and that the bundled standards are the wiki's head (--no-check skips the
  three gates); then tags vX.Y.Z and pushes the tag. --yes skips the confirm.
  The bump itself: Actions -> release-pr -> Run workflow, or
  bash scripts/bump-version.sh [patch|minor|major|X.Y.Z] and a pull request.
EOF
        return 0 ;;
      *) coop_die "unknown arg '$1' — usage: coop release [--yes] [--no-check]" ;;
    esac
    shift
  done

  have git || coop_die "git is required for 'coop release'."
  git -C "$COOP_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || coop_die "$COOP_ROOT is not a git checkout."
  [ -z "$(git -C "$COOP_ROOT" status --porcelain)" ] \
    || coop_die "working tree not clean — commit or stash your changes before releasing."
  coop_release_require_main

  local ver head_sha
  ver="$(coop_release_check_tree)"
  if git -C "$COOP_ROOT" rev-parse -q --verify "refs/tags/v$ver" >/dev/null 2>&1; then
    coop_die "tag v$ver already exists here — v$ver is released; the next release starts with a new release PR."
  fi
  if [ -n "$(git -C "$COOP_ROOT" ls-remote --tags origin "refs/tags/v$ver" 2>/dev/null)" ]; then
    coop_die "tag v$ver already exists on origin — v$ver is released; the next release starts with a new release PR."
  fi
  coop_ok "VERSION, the manifests and CHANGELOG agree on $ver, not yet tagged"

  head_sha="$(git -C "$COOP_ROOT" rev-parse HEAD)"
  if [ "$do_check" = "1" ]; then
    local verdict
    verdict="$(coop_release_ci_verdict "$head_sha")"
    case "$verdict" in
      green*)   coop_ok "CI is green on ${head_sha:0:7} (${verdict#green } check runs) — the release PR and this merge commit carry the test evidence" ;;
      running*) coop_die "CI is still running on ${head_sha:0:7} (${verdict#running }) — wait for it to finish, then re-run coop release; or re-run with --no-check." ;;
      red*)     coop_die "CI is red on ${head_sha:0:7}: ${verdict#red } — fix main first, or re-run with --no-check." ;;
      none)     coop_die "GitHub has no CI runs for ${head_sha:0:7} — wait for ci.yml on main, or re-run with --no-check." ;;
      *)        coop_die "could not read CI for ${head_sha:0:7} (${verdict#unreachable }) — check CI on GitHub and re-run with --no-check." ;;
    esac
    coop_release_check_pins "$assume_yes" \
      || { coop_info "release cancelled — nothing changed."; return 1; }
    coop_release_check_bundle "$assume_yes" \
      || { coop_info "release cancelled — nothing changed."; return 1; }
  fi

  if [ "$assume_yes" != "1" ]; then
    coop_confirm "Tag v$ver at ${head_sha:0:7} and push the tag? (release.yml then builds the installer, publishes the GitHub Release and opens the coop-website sync PR)" \
      || { coop_info "release cancelled — nothing changed."; return 1; }
  fi

  git -C "$COOP_ROOT" tag -a "v$ver" -m "coop-agent v$ver" || coop_die "git tag failed."
  local push_err
  # The fully qualified ref: a stray branch named like the tag cannot be pushed in its place.
  if push_err="$(git -C "$COOP_ROOT" push --quiet origin "refs/tags/v$ver" 2>&1)"; then
    coop_ok "released v$ver: pushed tag v$ver (watch release.yml on GitHub)"
  else
    [ -z "$push_err" ] || printf '%s\n' "$push_err" >&2
    coop_die "push failed — v$ver exists only on this machine. Retry: git push origin v$ver — or drop it: git tag -d v$ver"
  fi
}

# Sourceable for tests (tests/release-gate.test.sh): run only when executed.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  coop_release "$@"
fi
