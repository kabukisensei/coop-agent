#!/usr/bin/env bash
# The release gate on a host without a working PowerShell 7 (scripts/release.sh):
# every local suite needs pwsh, so coop release verifies GitHub CI on the commit
# instead. This checks the verdict reader against saved check-runs responses and
# the pwsh probe, offline; the live gate is exercised by Aaron's releases.
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

# The pwsh probe: a PATH without pwsh fails with the reason; a pwsh that cannot
# start fails with its first error line.
# shellcheck disable=SC2123  # an empty PATH is the point: no pwsh anywhere
why="$(PATH="$TMP/nopath"; coop_release_pwsh_ready && printf 'READY' || printf '%s' "$COOP_RELEASE_PWSH_WHY")"
case "$why" in
  *"not on PATH"*) ok "no pwsh on PATH: probe fails and names it" ;;
  *) ko "no pwsh on PATH: got '$why'" ;;
esac
mkdir -p "$TMP/badpwsh"; printf '#!/bin/sh\necho "You must install .NET to run this application." >&2\nexit 131\n' > "$TMP/badpwsh/pwsh"; chmod +x "$TMP/badpwsh/pwsh"
# shellcheck disable=SC2123
why="$(PATH="$TMP/badpwsh:$PATH"; coop_release_pwsh_ready && printf 'READY' || printf '%s' "$COOP_RELEASE_PWSH_WHY")"
case "$why" in
  *"does not start"*"install .NET"*) ok "a pwsh that cannot start: probe fails with its error" ;;
  *) ko "broken pwsh: got '$why'" ;;
esac
if command -v pwsh >/dev/null 2>&1 && pwsh -NoLogo -NoProfile -Command 'exit 0' >/dev/null 2>&1; then
  if coop_release_pwsh_ready; then ok "a working pwsh passes the probe"; else ko "working pwsh should pass the probe"; fi
fi

# The remote parser: origin spellings that are github.com, and one that is not.
git_remote_for() { ( COOP_ROOT="$TMP/r$RANDOM"; git init -q "$COOP_ROOT"; git -C "$COOP_ROOT" remote add origin "$1"; coop_release_github_repo ); }
[ "$(git_remote_for https://github.com/kabukisensei/coop-agent.git)" = "kabukisensei/coop-agent" ] && ok "https origin -> owner/repo" || ko "https origin"
[ "$(git_remote_for git@github.com:kabukisensei/coop-agent.git)" = "kabukisensei/coop-agent" ] && ok "ssh origin -> owner/repo" || ko "ssh origin"
[ -z "$(git_remote_for https://dev.azure.com/org/proj/_git/repo)" ] && ok "non-GitHub origin -> empty (gate reports unreachable)" || ko "non-GitHub origin"

echo "release gate: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
