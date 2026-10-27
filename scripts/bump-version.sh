#!/usr/bin/env bash
#
# bump-version.sh — move this checkout to the next coop-agent version (no git).
#
#   bash scripts/bump-version.sh [patch|minor|major|X.Y.Z] [--date YYYY-MM-DD]
#
# Writes the new version to VERSION, config/release-manifest.json (coop_version)
# and every extensions/*/package.json, and rolls CHANGELOG.md's [Unreleased]
# section into a dated [X.Y.Z] heading (a fresh, empty [Unreleased] stays above
# it). Prints the new version. Default: patch. It never commits: the release
# pull request workflow (.github/workflows/release-pr.yml) runs it and opens the
# PR; by hand, commit the result as "Release vX.Y.Z" and open the PR yourself.
# Tagging is `coop release` (scripts/release.sh), after that PR has merged.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

level="patch"; today="$(date +%F)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    patch|minor|major) level="$1" ;;
    --date) shift; today="${1:-}"; case "$today" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) die "--date wants YYYY-MM-DD, got '$today'" ;; esac ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    *) case "$1" in *[!0-9.]*|.*|*.|*..*|*.*.*.*|'') die "unknown argument '$1' — usage: bash scripts/bump-version.sh [patch|minor|major|X.Y.Z] [--date YYYY-MM-DD]" ;; esac
       case "$1" in *.*.*) level="$1" ;; *) die "a version is X.Y.Z, got '$1'" ;; esac ;;
  esac
  shift
done

[ -f "$ROOT/VERSION" ] || die "VERSION file missing at $ROOT/VERSION"
cur="$(tr -d '[:space:]' < "$ROOT/VERSION")"
case "$cur" in ''|*[!0-9.]*|.*|*.|*..*|*.*.*.*) die "VERSION ('$cur') is not X.Y.Z" ;; esac
IFS=. read -r ma mi pa <<<"$cur"
for f in "$ma" "$mi" "$pa"; do case "$f" in ''|*[!0-9]*) die "VERSION ('$cur') is not X.Y.Z" ;; esac; done
manifest="$ROOT/config/release-manifest.json"
[ -f "$manifest" ] || die "release manifest missing at $manifest"
manifest_cur="$(sed -n 's/^[[:space:]]*"coop_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest")"
[ "$manifest_cur" = "$cur" ] || die "release manifest coop_version ('$manifest_cur') does not match VERSION ('$cur') — align it first"

case "$level" in
  major) new="$((ma + 1)).0.0" ;;
  minor) new="${ma}.$((mi + 1)).0" ;;
  patch) new="${ma}.${mi}.$((pa + 1))" ;;
  *)     new="$level" ;;
esac
[ "$new" != "$cur" ] || die "VERSION is already $cur"
# An explicit version must move forward (the fleet follows the newest tag).
newest="$(printf '%s\n%s\n' "$cur" "$new" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
[ "$newest" = "$new" ] || die "$new is older than the current $cur — a release never moves backwards"

grep -q '^## \[Unreleased\]' "$ROOT/CHANGELOG.md" 2>/dev/null || die "CHANGELOG.md has no '## [Unreleased]' heading"
if ! awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{exit} f && /^- |^### /{found=1} END{exit !found}' "$ROOT/CHANGELOG.md"; then
  printf '! CHANGELOG.md has nothing under [Unreleased]; the %s section will be empty\n' "$new" >&2
fi

printf '%s\n' "$new" > "$ROOT/VERSION"
tmp="$(mktemp)"
sed 's/^\([[:space:]]*"coop_version"[[:space:]]*:[[:space:]]*"\)[^"]*\(".*\)$/\1'"$new"'\2/' "$manifest" > "$tmp" && mv "$tmp" "$manifest"
for f in "$ROOT"/extensions/*/package.json; do
  [ -f "$f" ] || continue
  tmp="$(mktemp)"
  sed 's/"version": *"[0-9][^"]*"/"version": "'"$new"'"/' "$f" > "$tmp" && mv "$tmp" "$f"
done
tmp="$(mktemp)"
awk -v ver="$new" -v d="$today" '
  !done && /^## \[Unreleased\]/ { print; print ""; print "## [" ver "] — " d; done=1; next }
  { print }
' "$ROOT/CHANGELOG.md" > "$tmp" && mv "$tmp" "$ROOT/CHANGELOG.md"
printf '%s\n' "$new"
