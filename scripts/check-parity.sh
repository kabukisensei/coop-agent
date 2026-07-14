#!/usr/bin/env bash
#
# check-parity.sh — cross-platform parity + encoding gate (run by CI, and locally
# before a PR: `bash scripts/check-parity.sh`).
#
# coop ships paired bash + PowerShell implementations (see CONTRIBUTING.md):
#   1. every scripts/*.sh must have a scripts/*.ps1 twin (and vice versa),
#      except intentional singletons listed in ALLOWLIST below;
#   2. bin/coop and bin/coop.ps1 must both exist, and so must the shared helper
#      libraries lib/common.sh and lib/common.ps1 (its dot-sourced twin);
#   3. every .ps1 in the repo must start with the UTF-8 BOM (EF BB BF) —
#      Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI (mojibake);
#   4. STRUCTURAL parity (grep-based, best-effort — catches the drift the file-level
#      checks can't): bin/coop and bin/coop.ps1 must dispatch the SAME subcommand
#      tokens, and install/update/doctor's bash and PowerShell arg parsers must
#      recognize the SAME flags. A subcommand or flag added to only one side fails here.
#
# bash 3.2 compatible (macOS stock /bin/bash). Exits non-zero listing offenders.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
cd "$ROOT"

PARITY_TMP="$(mktemp -d)"
trap 'rm -rf "$PARITY_TMP"' EXIT

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

echo "→ lib/common.sh ↔ lib/common.ps1"
# The shared helper libraries are twins: every .sh sources common.sh, every .ps1
# dot-sources common.ps1. A helper changed in one must be ported to the other in
# the same change (see CONTRIBUTING.md → PowerShell requirements).
for f in lib/common.sh lib/common.ps1; do
  if [ -f "$f" ]; then
    ok "$f"
  else
    ko "$f is missing — the shared helper libraries (bash + PowerShell twins) must both exist"
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

# --- Structural parity (grep-based) ------------------------------------------
# These extractors are deliberately simple and anchored on the real markers in the
# dispatchers/parsers, so an unrelated `case`/`switch` elsewhere isn't swept in.
# They print SORTED token sets; a set difference means the two sides drifted.

# Subcommand tokens from bin/coop's `# --- Dispatch` case block (patterns are the
# only 2-space-indented, non-comment lines; split on `|`; drop the `*`/`-*` catch-alls).
_bash_dispatch() {
  awk '/^# --- Dispatch/{f=1;next} f&&/^esac/{exit} f' bin/coop \
    | grep -E '^  [^ #]' \
    | sed -E 's/\).*$//; s/^[[:space:]]+//' \
    | tr '|' '\n' | tr -d "\"'" \
    | awk '{gsub(/^[ \t]+|[ \t]+$/,"")} NF && $0 !~ /^-?\*$/' | sort -u
}
# Subcommand tokens from bin/coop.ps1's `switch -CaseSensitive ($cmd)`: the first
# quoted token of a `'x' { … }` label, plus every quoted token of a compound
# `{ $_ -ceq 'x' -or … } {` label. `default` and the empty `''` label are excluded.
# (Compound labels use the case-sensitive `-ceq` to match bash's case-sensitive
# `case`; the extractor accepts `-eq`/`-ceq` so either spelling is still seen.)
_ps_dispatch() {
  local block; block="$(awk '/switch -CaseSensitive \(\$cmd\)/{f=1} f{print} f&&/^}$/{exit}' bin/coop.ps1)"
  { printf '%s\n' "$block" | grep -E "^[[:space:]]*'[^']+'[[:space:]]*\{" | sed -E "s/^[[:space:]]*'([^']+)'.*/\1/"
    printf '%s\n' "$block" | grep -E "^[[:space:]]*\{.*-c?eq '" | grep -oE "'[^']*'" | tr -d "'"
  } | awk '{gsub(/^[ \t]+|[ \t]+$/,"")} NF && $0 != "default"' | sort -u
}
# Recognized flags from a bash arg parser: the `-flag)` / `-a|--flag)` case patterns.
_bash_flags() {
  grep -oE '^[[:space:]]*-{1,2}[A-Za-z][A-Za-z0-9-]*(\|-{1,2}[A-Za-z][A-Za-z0-9-]*)*\)' "$1" \
    | sed -E 's/\)$//; s/^[[:space:]]+//' | tr '|' '\n' | awk 'NF' | sort -u
}
# Recognized flags from a PowerShell arg parser: `'-flag' { … }` switch labels and
# `-eq '-flag'` / `-ceq '-flag'` comparisons (scoped so version-command args like
# '--version' don't leak). `-c?eq` matches the case-sensitive `-ceq` used in compound
# switch labels (see #33) as well as a plain `-eq`.
_ps_flags() {
  grep -E "^[[:space:]]*'-{1,2}[A-Za-z][^']*'[[:space:]]*\{|-c?eq '-" "$1" \
    | grep -oE "'-{1,2}[A-Za-z][A-Za-z0-9-]*'" | tr -d "'" | awk 'NF' | sort -u
}
_report_diff() { # <label> <bash-list-file> <ps-list-file>
  if diff "$2" "$3" >/dev/null 2>&1; then
    ok "$1"
  else
    ko "$1 — bash and PowerShell disagree"
    printf '      bash: %s\n' "$(tr '\n' ' ' < "$2")"
    printf '      ps  : %s\n' "$(tr '\n' ' ' < "$3")"
  fi
}

echo "→ dispatch-table parity (bin/coop ↔ bin/coop.ps1 subcommands)"
_bash_dispatch > "$PARITY_TMP/disp-bash" || true
_ps_dispatch   > "$PARITY_TMP/disp-ps"   || true
_report_diff "bin/coop ↔ bin/coop.ps1 dispatch subcommands match" "$PARITY_TMP/disp-bash" "$PARITY_TMP/disp-ps"

echo "→ flag parity (install / update / doctor / uninstall arg parsers)"
for pair in install update doctor uninstall; do
  _bash_flags "scripts/$pair.sh"  > "$PARITY_TMP/$pair-bash" || true
  _ps_flags   "scripts/$pair.ps1" > "$PARITY_TMP/$pair-ps"   || true
  _report_diff "scripts/$pair.{sh,ps1} recognize the same flags" "$PARITY_TMP/$pair-bash" "$PARITY_TMP/$pair-ps"
done

if [ "$fail" -ne 0 ]; then
  echo "✗ parity check FAILED — fix the offenders above (see CONTRIBUTING.md → PowerShell requirements)"
  exit 1
fi
echo "✓ parity check passed"
