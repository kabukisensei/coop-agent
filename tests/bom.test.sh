#!/usr/bin/env bash
#
# Byte-level BOM regression tests (review finding 1): every .ps1 must start
# with EXACTLY ONE UTF-8 BOM. A duplicate BOM is invisible in most editors but
# makes PowerShell treat the shebang/comment first line as a command — the
# Windows launcher dies at startup with a command-not-found error even though
# syntax-parser checks pass. "A BOM exists" is not sufficient; the duplicate
# is what must be rejected.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
cd "$ROOT" || exit 1
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

BOM="$(printf '\357\273\277')"

while IFS= read -r f; do
  first3="$(head -c 3 "$f")"
  first6="$(head -c 6 "$f")"
  if [ "$first6" = "$BOM$BOM" ]; then
    ko "$f starts with TWO UTF-8 BOMs (launcher regression: first line parses as a command)"
    continue
  fi
  if [ "$first3" != "$BOM" ]; then
    ko "$f is missing the UTF-8 BOM entirely (PowerShell 5.1 reads it as ANSI)"
    continue
  fi
  ok "$f exactly one UTF-8 BOM"
done < <(find . -name '*.ps1' -not -path './.git/*' -not -path '*/node_modules/*' -not -path './.cache/*' | sed 's|^\./||' | sort)

# The two launch-critical files must have a comment line right after the BOM
# (a duplicate BOM leaves U+FEFF before '#!' and PowerShell chokes on it).
for f in bin/coop.ps1 scripts/sync-knowledge.ps1; do
  first_line="$(head -c 256 "$f" | tr -d '\r' | sed -n 1p)"
  first_line="${first_line#"$BOM"}"
  case "$first_line" in
    '#!'*)   ok "$f first line is a shebang comment after the BOM" ;;
    *)       ko "$f first line is not a comment (leading garbage/BOM?): ${first_line}" ;;
  esac
done

exit $fail
