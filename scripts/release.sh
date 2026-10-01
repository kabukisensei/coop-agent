#!/usr/bin/env bash
#
# release.sh — cut a coop-agent release (maintainers; Aaron runs this on his Mac).
#
#   ./bin/coop release [patch|minor|major] [--yes] [--no-push] [--no-check]
#   bash scripts/release.sh ...            (same thing)
#
# Bumps VERSION, config/release-manifest.json and every extensions/*/package.json,
# rolls CHANGELOG.md's [Unreleased] into a dated [X.Y.Z] heading, commits, tags
# vX.Y.Z and pushes main + the tag in one atomic push. Gates first: extensions
# transpile, the full test lanes (bash tests/run.sh and, when pwsh is on PATH,
# tests/run.ps1 and scripts/check-bom.ps1), and the manifest's coop-tool pins
# against the sibling coop-website's versions.json. Requires a clean tree on an attached main
# that equals origin/main. Runbook: RELEASE.md.
#
# This is the one maintainer command that stays in bash after master plan S1
# (the product runs in PowerShell: bin/coop.ps1); it is dev tooling, not a
# product path, and it needs the bash test runner anyway. Self-contained: the
# few helpers it uses are defined below, not sourced from a shared library.
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
# bin/coop.ps1's Test-CoopReleasePins is the same gate for `coop release` on Windows.
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
  # The pipx-published Coop tools the manifest pins (coop-data-doc only since ST1).
  local pin_tools="coop-data-doc"
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

# --- Release: bump version, roll CHANGELOG, commit + tag (+ push) -------------
# Cut a release with one command. Bumps VERSION, release-manifest.json, and every
# extensions/*/package.json; rolls the CHANGELOG's [Unreleased] section into a
# dated [X.Y.Z] heading; commits, tags vX.Y.Z, and pushes main + the tag in one
# atomic push. Requires a clean tree on an attached main that equals origin/main.
coop_release() {
  local level="" assume_yes=0 do_push=1 do_check=1
  while [ "$#" -gt 0 ]; do
    case "$1" in
      patch|minor|major) level="$1" ;;
      -y|--yes)          assume_yes=1 ;;
      --no-push)         do_push=0 ;;
      --check)           do_check=1 ;;
      --no-check)        do_check=0 ;;
      -h|--help)
        cat >&2 <<'EOF'
Usage: coop release [patch|minor|major] [--yes] [--no-push] [--no-check]
  Bump VERSION + release/extension manifests, roll CHANGELOG [Unreleased] into
  a dated release, commit, tag vX.Y.Z, and push main + the tag atomically (both
  or neither). Default: patch.
  Verifies extensions transpile + tests + the .ps1 BOM check pass, and that
  the manifest's coop-tool pins match the sibling coop-website's versions.json
  (--no-check to skip).
  Requires a clean working tree on main, equal to origin/main (it fetches origin).
EOF
        return 0 ;;
      *) coop_die "unknown arg '$1' — usage: coop release [patch|minor|major] [--yes] [--no-push] [--no-check]" ;;
    esac
    shift
  done
  [ -n "$level" ] || level="patch"

  have git || coop_die "git is required for 'coop release'."
  git -C "$COOP_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || coop_die "$COOP_ROOT is not a git checkout."
  [ -z "$(git -C "$COOP_ROOT" status --porcelain)" ] \
    || coop_die "working tree not clean — commit or stash your changes before releasing."
  coop_release_require_main

  local cur new ma mi pa
  # Guard the read first: a missing/unreadable VERSION makes the `<` redirect fail
  # BEFORE `2>/dev/null` applies, so under `set -e` bash would abort with a raw error
  # instead of reaching the friendly validation below.
  [ -f "$COOP_ROOT/VERSION" ] || coop_die "VERSION file missing at $COOP_ROOT/VERSION — fix it before releasing."
  cur="$(tr -d '[:space:]' < "$COOP_ROOT/VERSION" 2>/dev/null || true)"
  # Strict X.Y.Z. The old loose globs let e.g. '1abc.2.3' or '1.2.3.4' through, then
  # `$((ma + 1))` aborted mid-release with a raw arithmetic error under `set -e`.
  case "$cur" in
    ''|*[!0-9.]*|.*|*.|*..*|*.*.*.*) coop_die "VERSION ('$cur') is not X.Y.Z — fix it before releasing." ;;
  esac
  IFS=. read -r ma mi pa <<<"$cur"
  for _f in "$ma" "$mi" "$pa"; do
    case "$_f" in ''|*[!0-9]*) coop_die "VERSION ('$cur') is not X.Y.Z — fix it before releasing." ;; esac
  done
  local release_manifest="$COOP_ROOT/config/release-manifest.json" manifest_cur
  [ -f "$release_manifest" ] || coop_die "release manifest missing at $release_manifest — fix it before releasing."
  manifest_cur="$(sed -n 's/^[[:space:]]*"coop_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$release_manifest")"
  [ "$manifest_cur" = "$cur" ] \
    || coop_die "release manifest coop_version ('$manifest_cur') does not match VERSION ('$cur') — align it before releasing."
  case "$level" in
    major) new="$((ma + 1)).0.0" ;;
    minor) new="${ma}.$((mi + 1)).0" ;;
    patch) new="${ma}.${mi}.$((pa + 1))" ;;
  esac

  if git -C "$COOP_ROOT" rev-parse "v$new" >/dev/null 2>&1; then coop_die "tag v$new already exists."; fi

  # Pre-flight: never tag code that doesn't transpile. Skips silently when npx is
  # unavailable; bypass with --no-check.
  if [ "$do_check" = "1" ]; then
    # Track whether the transpile/test gate actually ran. A host missing npx/node
    # skips those halves; if a push is requested we fail closed below rather than
    # publish an unverified tag — mirroring bin/coop.ps1's Invoke-CoopRelease.
    local gate_skipped=0
    if have npx; then
      local extf build_fail=0
      for extf in "$COOP_ROOT"/extensions/*/index.ts; do
        [ -f "$extf" ] || continue
        if ! npx -y esbuild "$extf" --bundle --format=esm --platform=node --packages=external --outfile=/dev/null >/dev/null 2>&1; then
          coop_warn "extension does not build: ${extf#"$COOP_ROOT"/}"; build_fail=1
        fi
      done
      [ "$build_fail" = "1" ] && coop_die "extension build check failed — fix it, or re-run with --no-check."
      coop_ok "extensions build"
    else
      coop_warn "npx not found — skipping the extension build check."; gate_skipped=1
    fi

    # A release tags exactly the (clean) working tree, so gate on the full Node
    # suite, the PowerShell suite when pwsh is installed, and the .ps1 BOM check
    # — the transpile above only proves the extensions compile. These run on the
    # already-clean tree, so they test precisely what will ship.
    # COOP_TEST_EXTENDED=1 runs BOTH test lanes (gate + extended), so a release
    # keeps the full coverage that CI splits between ci.yml (gate, every PR) and
    # extended.yml (nightly). See docs/ci.md. Mirrors bin/coop.ps1.
    if [ -f "$COOP_ROOT/tests/run.sh" ]; then
      if have node; then
        local test_log; test_log="$(mktemp)" || coop_die "mktemp failed."
        if COOP_TEST_EXTENDED=1 bash "$COOP_ROOT/tests/run.sh" >"$test_log" 2>&1; then
          coop_ok "tests pass (gate + extended lanes)"; rm -f "$test_log"
        else
          cat "$test_log" >&2; rm -f "$test_log"
          coop_die "tests failed (COOP_TEST_EXTENDED=1 bash tests/run.sh, gate + extended lanes) — fix them, or re-run with --no-check."
        fi
      else
        coop_warn "node not found — skipping the test suite."; gate_skipped=1
      fi
    fi
    # The PowerShell suite is the product's own test lane (coop runs in
    # PowerShell). pwsh is optional on a Mac, so a missing pwsh warns rather than
    # fails: native Windows CI is the evidence for Windows PowerShell 5.1.
    if [ -f "$COOP_ROOT/tests/run.ps1" ]; then
      if have pwsh; then
        local ps_log; ps_log="$(mktemp)" || coop_die "mktemp failed."
        if pwsh -NoLogo -NoProfile -File "$COOP_ROOT/tests/run.ps1" >"$ps_log" 2>&1; then
          coop_ok "PowerShell tests pass (tests/run.ps1)"; rm -f "$ps_log"
        else
          cat "$ps_log" >&2; rm -f "$ps_log"
          coop_die "PowerShell tests failed (pwsh -File tests/run.ps1) — fix them, or re-run with --no-check."
        fi
      else
        coop_warn "pwsh not found — skipping tests/run.ps1 (CI runs it on Windows and Linux)."
      fi
    fi
    # The .ps1 encoding gate is PowerShell (scripts/check-bom.ps1); like
    # tests/run.ps1 above, a missing pwsh warns rather than fails.
    if [ -f "$COOP_ROOT/scripts/check-bom.ps1" ]; then
      if have pwsh; then
        if pwsh -NoLogo -NoProfile -File "$COOP_ROOT/scripts/check-bom.ps1" >/dev/null 2>&1; then
          coop_ok "BOM check passes (scripts/check-bom.ps1)"
        else
          coop_die "BOM check failed (pwsh -NoProfile -File scripts/check-bom.ps1) — fix it, or re-run with --no-check."
        fi
      else
        coop_warn "pwsh not found — skipping scripts/check-bom.ps1 (tests/run.ps1 runs it in CI)."
      fi
    fi

    # Fail closed: a host that could not run the transpile/test gate must not
    # PUBLISH an unverified tag. Bumping/committing locally (--no-push) is fine; a
    # push requires the gate to have run — or an explicit --no-check opt-out (which
    # skips this whole block). Matches bin/coop.ps1's Invoke-CoopRelease.
    if [ "$gate_skipped" = "1" ] && [ "$do_push" = "1" ]; then
      coop_die "release gate could not run (npx/node not found) — install Node.js, use --no-push to bump locally only, or --no-check to release without gating."
    fi

    # The manifest's coop-tool pins vs the sibling coop-website's versions.json: a mismatch
    # dies; a missing sibling warns + confirms (--yes continues). See the
    # function header above and RELEASE.md.
    coop_release_check_pins "$assume_yes" \
      || { coop_info "release cancelled — nothing changed."; return 1; }
  fi

  local pushmsg=""; [ "$do_push" = "1" ] && pushmsg=" + push"
  if [ "$assume_yes" != "1" ]; then
    coop_confirm "Release v${cur} → v${new}? (bump VERSION + manifests, roll CHANGELOG, commit, tag v${new}${pushmsg})" \
      || { coop_info "release cancelled — nothing changed."; return 1; }
  fi

  local today tmp f
  today="$(date +%F)"

  # 1. VERSION
  printf '%s\n' "$new" > "$COOP_ROOT/VERSION"

  # 2. release manifest + extension manifests (sed without -i for portability)
  tmp="$(mktemp)" || coop_die "mktemp failed."
  sed 's/^\([[:space:]]*"coop_version"[[:space:]]*:[[:space:]]*"\)[^"]*\(".*\)$/\1'"$new"'\2/' \
    "$release_manifest" > "$tmp" || coop_die "could not update release manifest."
  mv "$tmp" "$release_manifest" || coop_die "could not replace release manifest."
  for f in "$COOP_ROOT"/extensions/*/package.json; do
    [ -f "$f" ] || continue
    tmp="$(mktemp)" || coop_die "mktemp failed."
    sed 's/"version": *"[0-9][^"]*"/"version": "'"$new"'"/' "$f" > "$tmp" && mv "$tmp" "$f"
  done

  # 3. CHANGELOG: insert a dated [X.Y.Z] heading right under [Unreleased]
  if grep -q '^## \[Unreleased\]' "$COOP_ROOT/CHANGELOG.md" 2>/dev/null; then
    tmp="$(mktemp)" || coop_die "mktemp failed."
    awk -v ver="$new" -v d="$today" '
      !done && /^## \[Unreleased\]/ { print; print ""; print "## [" ver "] — " d; done=1; next }
      { print }
    ' "$COOP_ROOT/CHANGELOG.md" > "$tmp" && mv "$tmp" "$COOP_ROOT/CHANGELOG.md"
  else
    coop_warn "no '## [Unreleased]' heading in CHANGELOG.md — skipped the changelog roll."
  fi

  # 4. commit + tag. Stage ONLY the files a release actually touches — never `add -A`,
  # which would sweep in anything created during the (slow) gate window if another
  # agent or an editor autosave shares the tree (this is how a spurious empty release
  # got cut once). VERSION + CHANGELOG are repo-relative to git's -C dir.
  git -C "$COOP_ROOT" add VERSION CHANGELOG.md config/release-manifest.json
  for f in "$COOP_ROOT"/extensions/*/package.json; do
    [ -f "$f" ] && git -C "$COOP_ROOT" add "$f"
  done
  git -C "$COOP_ROOT" commit -q -m "Release v$new" || coop_die "git commit failed."
  git -C "$COOP_ROOT" tag -a "v$new" -m "coop-agent v$new" || coop_die "git tag failed."
  coop_ok "released v$new (was v$cur)"

  # 5. push main and the tag in ONE atomic push (#105): if origin rejects either
  # ref (main moved during the gate, a protected branch, an existing tag), neither
  # lands, so the tag can never reach origin off main. Fully qualified refs, so a
  # stray tag named 'main' cannot be pushed in place of the branch.
  if [ "$do_push" = "1" ]; then
    local push_err
    if push_err="$(git -C "$COOP_ROOT" push --atomic --quiet origin refs/heads/main "refs/tags/v$new" 2>&1)"; then
      coop_ok "pushed main + tag v$new"
    else
      [ -z "$push_err" ] || printf '%s\n' "$push_err" >&2
      coop_die "push failed — nothing was pushed (atomic), so v$new exists only on this machine. Retry: git push --atomic origin main v$new — or, if origin/main moved, undo the local release (git tag -d v$new && git reset --keep HEAD~1), git pull --ff-only, and re-run coop release."
    fi
  else
    coop_info "not pushed (--no-push). When ready: git push --atomic origin main v$new"
  fi
}

coop_release "$@"
