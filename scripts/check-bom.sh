#!/usr/bin/env bash
#
# check-bom.sh — PowerShell source encoding gate (run by CI's shell + config lint
# job, and locally before a PR: `bash scripts/check-bom.sh`). Successor of the
# retired scripts/check-parity.sh (master plan S1): coop has one implementation,
# in PowerShell, so the bash/PowerShell pairing checks are gone and only the
# encoding rules remain:
#   1. every .ps1 in the repo starts with exactly ONE UTF-8 BOM (EF BB BF) —
#      Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI (mojibake), and a
#      duplicate BOM makes it parse the shebang line as a command;
#   2. the launch-critical .ps1 files have a `#!` comment right after the BOM;
#   3. no .ps1 ends a line with a bash-style backslash continuation (#90).
# This is the repo's one BOM check (tests/bom.test.sh and run.ps1's section-0
# check were folded in here, #96). Dev/CI tool: bash is not a product runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
cd "$ROOT"

fail=0
ko() { printf '  ✗ %s\n' "$1"; fail=1; }
ok() { printf '  ✓ %s\n' "$1"; }

echo "→ UTF-8 BOM on every .ps1 (exactly one — a duplicate BOM breaks the launcher)"
BOM="$(printf '\357\273\277')"
while IFS= read -r f; do
  head6="$(head -c 6 "$f")"
  if [ "$head6" = "$BOM$BOM" ]; then
    ko "$f starts with TWO UTF-8 BOMs — the extra BOM makes PowerShell parse the shebang as a command. Fix: strip all leading BOMs, then prepend exactly one"
  elif [ "$(head -c 3 "$f")" = "$BOM" ]; then
    ok "$f"
  else
    ko "$f is missing the UTF-8 BOM — fix: printf '\\357\\273\\277' | cat - '$f' > '$f.bom' && mv '$f.bom' '$f'"
  fi
done < <(find . -name '*.ps1' -not -path './.git/*' -not -path '*/node_modules/*' -not -path './.cache/*' | sed 's|^\./||' | sort)

echo "→ launch-critical .ps1 first line is a comment after the BOM"
# The launcher and the knowledge sync script must have a '#!' comment line right
# after the BOM: a duplicate BOM leaves U+FEFF before '#!' and PowerShell chokes
# on it (review finding 1; formerly tests/bom.test.sh).
for f in bin/coop.ps1 scripts/sync-knowledge.ps1; do
  if [ ! -f "$f" ]; then
    ko "$f is missing — cannot check its first line"
    continue
  fi
  first_line="$(head -c 256 "$f" | tr -d '\r' | sed -n 1p)"
  first_line="${first_line#"$BOM"}"
  case "$first_line" in
    '#!'*) ok "$f first line is a shebang comment after the BOM" ;;
    *)     ko "$f first line is not a comment (leading garbage/BOM?): ${first_line}" ;;
  esac
done

echo "→ no bash-style backslash line continuation in any .ps1"
# PowerShell continues a line with a backtick, never a backslash. A trailing ' \'
# passes the parsers: the backslash becomes an argument and the next line runs as
# its own statement, which is how doctor.ps1 --json printed hints before its JSON
# (#90). Comments and here-string bodies (embedded sh scripts) are exempt.
bs_bad=0
while IFS= read -r f; do
  # Plain string tests, no octal escapes, so BSD awk on macOS reads it the same.
  hits="$(awk -v sq="'" '
    { line = $0; sub(/[[:space:]]+$/, "", line); lead = line; sub(/^[[:space:]]+/, "", lead) }
    here { if (substr(lead, 1, 2) == "\"@" || substr(lead, 1, 2) == sq "@") here = 0; next }
    substr(lead, 1, 1) == "#" { next }
    { tail = substr(line, length(line) - 1) }
    tail == "@\"" || tail == "@" sq { here = 1; next }
    tail ~ /[[:space:]]\\$/ { printf "%d ", NR }
  ' "$f")"
  if [ -n "$hits" ]; then
    ko "$f ends a line with a bash-style \\ continuation (line ${hits% }) — join the call onto one line or build the argument in a variable first"
    bs_bad=1
  fi
done < <(find . -name '*.ps1' -not -path './.git/*' -not -path '*/node_modules/*' -not -path './.cache/*' | sed 's|^\./||' | sort)
[ "$bs_bad" -eq 0 ] && ok "no .ps1 ends a line with a bash-style backslash continuation"

if [ "$fail" -ne 0 ]; then
  echo "✗ BOM check FAILED — fix the offenders above (see CONTRIBUTING.md → PowerShell requirements)"
  exit 1
fi
echo "✓ BOM check passed"
