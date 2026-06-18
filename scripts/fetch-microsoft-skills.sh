#!/usr/bin/env bash
#
# Fetch official Microsoft agent skills (https://github.com/microsoft/skills, MIT)
# into skills/_microsoft/ — only the ones allow-listed in .coop/project.yml under
# microsoft_skills.allow[]. Fetched skills are gitignored (pulled on demand, never
# vendored into this repo) and are SUBORDINATE to Cooptimize skills at load time.
#
# Usage: scripts/fetch-microsoft-skills.sh
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

have git || coop_die "git is required to fetch Microsoft skills."

proj="$(coop_find_project_yml)"
[ -n "$proj" ] || coop_die "No .coop/project.yml found."
src="$(coop_yaml_get "$proj" "microsoft_skills.source" "https://github.com/microsoft/skills")"
case "$src" in ""|TODO*) coop_die "Set microsoft_skills.source in $proj" ;; esac

allow="$(coop_yaml_list "$proj" "microsoft_skills.allow")"
if [ -z "$allow" ]; then
  coop_warn "microsoft_skills.allow[] is empty — nothing to fetch."
  coop_say  "      Add skill folder names to allow[] in $proj, then re-run."
  exit 0
fi

cache="$COOP_ROOT/.cache/microsoft-skills"
coop_head "Fetching Microsoft skills from $src"
if [ -d "$cache/.git" ]; then
  coop_info "Updating cache…"; git -C "$cache" pull --ff-only --depth 1 >/dev/null 2>&1 || coop_warn "cache pull failed (using existing)"
else
  mkdir -p "$(dirname "$cache")"
  coop_info "Cloning (shallow)…"; git clone --depth 1 "$src" "$cache" >/dev/null 2>&1 || coop_die "clone failed: $src"
fi

dest="$COOP_ROOT/skills/_microsoft"
mkdir -p "$dest"

# Build the set of our own skill names (folder + frontmatter) for conflict checks.
own=" "
for d in "$COOP_ROOT"/skills/*/; do
  name="$(basename "$d")"; [ "$name" = "_microsoft" ] && continue
  [ -f "${d}SKILL.md" ] || continue
  own="$own$name "
  fm="$(coop_skill_name "${d}SKILL.md")"; [ -n "$fm" ] && own="$own$fm "
done

count=0
# Feed the loop with a here-doc (not a pipe) so `count` survives in this shell.
while IFS= read -r skill; do
  [ -z "$skill" ] && continue
  case "$skill" in TODO*) continue ;; esac
  # Reject anything but a safe skill-folder charset (blocks globs / path traversal).
  case "$skill" in *[!a-zA-Z0-9._-]*) coop_warn "skip '$skill' — invalid skill name"; continue ;; esac
  case "$own" in *" $skill "*) coop_warn "skip '$skill' — conflicts with a Cooptimize skill (subordinate rule)"; continue ;; esac
  # microsoft/skills stores SKILL.md folders under .github/skills, plugins, or skills/
  found=""
  while IFS= read -r hit; do found="$(dirname "$hit")"; break; done <<EOF
$(find "$cache" -type f -path "*/$skill/SKILL.md" 2>/dev/null)
EOF
  if [ -z "$found" ]; then coop_warn "not found in source: $skill"; continue; fi
  fm="$(coop_skill_name "$found/SKILL.md")"
  case "$own" in *" $fm "*) coop_warn "skip '$skill' — frontmatter name '$fm' conflicts with a Cooptimize skill"; continue ;; esac
  rm -rf "${dest:?}/$skill"
  cp -R "$found" "$dest/$skill"
  coop_ok "fetched $skill"
  count=$((count+1))
done <<EOF
$allow
EOF

coop_ok "Done — fetched $count Microsoft skill(s) into $dest (gitignored; subordinate to Cooptimize skills)."
