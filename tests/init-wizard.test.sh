#!/usr/bin/env bash
#
# Tests for `coop init` (bin/coop.ps1 Invoke-CoopInit): the jobs that stayed after
# the Python wizard was retired (suite review 2026-10-26, pick 10). The project
# wizard itself is /setup-project (tests/project-wizard.test.mjs); here: the bare
# command points there, --template copies the documented example, and the C1
# placement rules (one contract per client Git root; the client home repository
# beside several repositories) still hold for the template.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# C1: `coop init --template` refuses to create a contract below one that already
# covers the folder, so a foreign .coop/project.yml above the temp root would fail
# every case here. Skip loudly instead of reporting a false failure.
probe="$TMP"
while [ "$probe" != "/" ] && [ -n "$probe" ]; do
  probe="$(dirname "$probe")"
  if [ -f "$probe/.coop/project.yml" ]; then
    echo "  SKIP init tests: a foreign contract covers the temp dir: $probe/.coop/project.yml"
    exit 0
  fi
done

# `coop init` is dispatched by bin/coop.ps1 (master plan S1: one implementation,
# in PowerShell); pwsh on macOS/Linux and CI, Windows PowerShell as the fallback.
PWSH="$(command -v pwsh 2>/dev/null || command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null || true)"
[ -z "$PWSH" ] && { echo "pwsh (PowerShell 7) required: coop init is dispatched by bin/coop.ps1"; exit 1; }
COOP_PS1="$ROOT/bin/coop.ps1"
if command -v cygpath >/dev/null 2>&1; then COOP_PS1="$(cygpath -w "$COOP_PS1")"; fi

coop_init() { HOME="$TMP" USERPROFILE="$TMP" "$PWSH" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$COOP_PS1" init "$@"; }

# --- the bare command is not a wizard any more: it points at /setup-project --------
mkdir -p "$TMP/repo/.git"
coop_init "$TMP/repo" >"$TMP/bare.out" 2>&1 </dev/null
rc=$?
[ "$rc" -ne 0 ] && ok "bare coop init exits non-zero (exit $rc)" || ko "bare coop init exited 0"
grep -q "/setup-project" "$TMP/bare.out" && ok "bare coop init points at /setup-project" || ko "no /setup-project pointer: $(cat "$TMP/bare.out")"
[ ! -e "$TMP/repo/.coop" ] && ok "bare coop init writes nothing" || ko "bare coop init wrote .coop"

# --- --template copies the documented example -----------------------------------
mkdir -p "$TMP/legacy"
coop_init --template "$TMP/legacy" >/dev/null 2>&1 </dev/null
rc=$?
[ "$rc" -eq 0 ] && ok "--template exits 0" || ko "--template exit: $rc"
[ -s "$TMP/legacy/.coop/project.yml" ] && ok "--template produced output" || ko "--template output empty"
if cmp -s "$ROOT/.coop/project.example.yml" "$TMP/legacy/.coop/project.yml"; then ok "--template is a byte copy of .coop/project.example.yml"; else ko "--template differs from the example"; fi
if grep -q '^standards:' "$TMP/legacy/.coop/project.yml"; then ko "template wrote default standards overrides"; else ok "template omits default standards overrides"; fi
coop_init --template "$TMP/legacy" >"$TMP/again.out" 2>&1 </dev/null
rc=$?
[ "$rc" -ne 0 ] && grep -q "already exists" "$TMP/again.out" && ok "--template never overwrites an existing contract" || ko "--template overwrote or did not refuse: $(cat "$TMP/again.out")"

# --- C1: one contract per client Git root; nothing is created below it ----------
mkdir -p "$TMP/client/.coop" "$TMP/client/analytics/.git" "$TMP/client/reports/.git"
printf "profile:\n  client: 'Contoso'\n" > "$TMP/client/.coop/project.yml"
coop_init --template "$TMP/client/reports" >"$TMP/below-ps.out" 2>&1 </dev/null
rc=$?
[ "$rc" -ne 0 ] && ok "coop init --template refuses a contract below an existing one (exit $rc)" || ko "coop init created a second contract below the root"
[ ! -e "$TMP/client/reports/.coop" ] && ok "coop init wrote nothing below the root contract" || ko "coop init wrote a second .coop below the root"
grep -q "a contract already covers this folder" "$TMP/below-ps.out" && ok "coop init names the covering contract" || ko "coop init refusal message missing: $(cat "$TMP/below-ps.out")"

# --- C1: beside several repositories, --template creates the client home repository
if command -v git >/dev/null 2>&1; then
  mkdir -p "$TMP/estate/analytics" "$TMP/estate/reports"
  git -C "$TMP/estate/analytics" init --quiet
  git -C "$TMP/estate/reports" init --quiet
  COOP_ASSUME_YES=1 COOP_INIT_CLIENT="Fabrikam Foods" coop_init --template "$TMP/estate/analytics" >"$TMP/home.out" 2>&1 </dev/null
  rc=$?
  [ "$rc" -eq 0 ] && ok "coop init --template exits 0 beside several repositories (home repo)" || ko "coop init home-repo exit $rc: $(cat "$TMP/home.out")"
  [ -f "$TMP/estate/fabrikam-foods-coop/.coop/project.yml" ] && ok "the project file went into the client home repository <client>-coop" || ko "no project file in the home repository: $(cat "$TMP/home.out")"
  [ -d "$TMP/estate/fabrikam-foods-coop/.git" ] && ok "the home repository was git-initialised" || ko "home repository has no .git"
  grep -q "Fabrikam Foods" "$TMP/estate/fabrikam-foods-coop/README.md" 2>/dev/null && ok "the home repository README names the client" || ko "home README missing or unnamed"
  [ ! -e "$TMP/estate/analytics/.coop" ] && [ ! -e "$TMP/estate/.coop" ] && ok "nothing was written in the repository or the parent folder" || ko "a contract appeared outside the home repository"
  grep -q "Not shared yet" "$TMP/home.out" && ok "without an origin, coop init says the file is not shared yet" || ko "missing 'Not shared yet' line: $(cat "$TMP/home.out")"
  coop_init --template "$TMP/estate/reports" >"$TMP/home2.out" 2>&1 </dev/null
  rc=$?
  [ "$rc" -ne 0 ] && grep -q "One project file per client" "$TMP/home2.out" && ok "a sibling repository finds the home repository's contract and refuses a second one" || ko "sibling lookup failed (exit $rc): $(cat "$TMP/home2.out")"
else
  echo "  SKIP home-repository cases: git not installed"
fi

exit $fail
