#!/usr/bin/env bash
#
# Validate coop's authored resources so a typo can't silently break loading:
#   • every skills/<name>/SKILL.md has a --- frontmatter block with name: + description:
#   • every prompts/<name>.md is non-empty
# Run locally with `bash scripts/validate-resources.sh`; CI runs it too.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0

for skill in "$ROOT"/skills/*/SKILL.md; do
  [ -f "$skill" ] || continue
  rel="${skill#"$ROOT"/}"
  # Frontmatter body = lines between the leading '---' and the next '---'.
  fm="$(awk 'NR==1 { if ($0 != "---") exit 1; next } $0 == "---" { exit } { print }' "$skill")"
  if [ -z "$fm" ]; then
    echo "✗ $rel: missing or malformed frontmatter (--- … ---)"; fail=1; continue
  fi
  printf '%s\n' "$fm" | grep -qE '^name:[[:space:]]*\S'        || { echo "✗ $rel: frontmatter missing 'name:'"; fail=1; }
  printf '%s\n' "$fm" | grep -qE '^description:[[:space:]]*\S' || { echo "✗ $rel: frontmatter missing 'description:'"; fail=1; }
  # A plain-style description must not contain ': ' — strict YAML parsers read it
  # as a nested mapping and skill loading breaks (real incident: custom-visuals).
  # Quoted values are fine; the case guard skips them.
  desc="$(printf '%s\n' "$fm" | grep '^description:' | sed 's/^description:[[:space:]]*//')"
  case "$desc" in
    \"*|\'*) : ;;
    *": "*) echo "✗ $rel: description contains unquoted ': ' — wrap the value in double quotes"; fail=1 ;;
  esac
done

for prompt in "$ROOT"/prompts/*.md; do
  [ -f "$prompt" ] || continue
  rel="${prompt#"$ROOT"/}"
  grep -qE '\S' "$prompt" || { echo "✗ $rel: empty prompt"; fail=1; }
done

if [ "$fail" -eq 0 ]; then
  echo "✓ skills + prompts valid"
else
  echo "resource validation failed"
  exit 1
fi
