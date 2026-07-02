#!/usr/bin/env bash
#
# check-parity.sh — cross-platform parity + encoding gate (run by CI, and locally
# before a PR: `bash scripts/check-parity.sh`).
#
# coop ships paired bash + PowerShell implementations (see CONTRIBUTING.md):
#   1. every scripts/*.sh must have a scripts/*.ps1 twin (and vice versa),
#      except intentional singletons listed in ALLOWLIST below;
#   2. bin/coop and bin/coop.ps1 must both exist;
#   3. every .ps1 in the repo must start with the UTF-8 BOM (EF BB BF) —
#      Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI (mojibake).
#
# bash 3.2 compatible (macOS stock /bin/bash). Exits non-zero listing offenders.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
cd "$ROOT"

# Intentional singletons (repo-relative paths). A dev/CI-only or platform-specific
# script goes here — with a reason — instead of growing a pointless twin.
ALLOWLIST=(
  "scripts/check-parity.sh"                    # this gate: CI + dev only, bash runners
  "scripts/fetch-microsoft-skills.sh"          # maintainer-side skill vendoring, bash only
  "scripts/migrate-from-pi-analytics-agent.sh" # one-time migration, predates Windows support
  "scripts/validate-resources.sh"              # CI-only skill/prompt lint, bash runners
)

allowed() {
  local f="$1" a
  for a in "${ALLOWLIST[@]}"; do
    [ "$a" = "$f" ] && return 0
  done
  return 1
}

fail=0
ko() { printf '  ✗ %s\n' "$1"; fail=1; }
ok() { printf '  ✓ %s\n' "$1"; }

echo "→ scripts/*.sh ↔ scripts/*.ps1 pairing"
for f in scripts/*.sh; do
  [ -e "$f" ] || continue
  base="${f%.sh}"
  if [ -f "$base.ps1" ]; then
    ok "$f ↔ $base.ps1"
  elif allowed "$f"; then
    ok "$f (allow-listed bash-only)"
  else
    ko "$f has no $base.ps1 twin — add one, or allow-list it in scripts/check-parity.sh with a reason"
  fi
done
for f in scripts/*.ps1; do
  [ -e "$f" ] || continue
  base="${f%.ps1}"
  if [ -f "$base.sh" ]; then
    :  # already reported in the .sh pass
  elif allowed "$f"; then
    ok "$f (allow-listed PowerShell-only)"
  else
    ko "$f has no $base.sh twin — add one, or allow-list it in scripts/check-parity.sh with a reason"
  fi
done

echo "→ bin/coop ↔ bin/coop.ps1"
for f in bin/coop bin/coop.ps1; do
  if [ -f "$f" ]; then
    ok "$f"
  else
    ko "$f is missing — the bash and PowerShell dispatchers must both exist"
  fi
done

echo "→ UTF-8 BOM on every .ps1"
BOM="$(printf '\357\273\277')"
while IFS= read -r f; do
  if [ "$(head -c 3 "$f")" = "$BOM" ]; then
    ok "$f"
  else
    ko "$f is missing the UTF-8 BOM — fix: printf '\\357\\273\\277' | cat - '$f' > '$f.bom' && mv '$f.bom' '$f'"
  fi
done < <(find . -name '*.ps1' -not -path './.git/*' -not -path '*/node_modules/*' | sed 's|^\./||' | sort)

if [ "$fail" -ne 0 ]; then
  echo "✗ parity check FAILED — fix the offenders above (see CONTRIBUTING.md → PowerShell requirements)"
  exit 1
fi
echo "✓ parity check passed"
