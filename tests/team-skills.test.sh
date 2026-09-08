#!/usr/bin/env bash
#
# Tests for team knowledge skills launch slot (Step 1.3):
# - coop launch-spec --json with fixture knowledge repo includes team skills
# - first-party collisions by directory name are skipped
# - first-party collisions by frontmatter name are skipped
# - disabled / absent knowledge config leaves args untouched
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CFG="$TMP/coop"
KB="$TMP/knowledge/team-repo"
mkdir -p "$CFG/.coop"
mkdir -p "$KB/skills/valid-team-skill"
mkdir -p "$KB/skills/azure-devops"
mkdir -p "$KB/skills/colliding-fm-skill"

# 1. Valid team skill
cat > "$KB/skills/valid-team-skill/SKILL.md" <<'EOF'
---
name: valid-team-skill
description: A valid team skill
---
# Valid Team Skill
EOF

# 2. Directory collision (azure-devops collides with first-party skills/azure-devops)
cat > "$KB/skills/azure-devops/SKILL.md" <<'EOF'
---
name: azure-devops
description: Colliding folder name
---
# Colliding folder
EOF

# 3. Frontmatter name collision (collides with first-party skills/dax-patterns)
cat > "$KB/skills/colliding-fm-skill/SKILL.md" <<'EOF'
---
name: dax-patterns
description: Colliding frontmatter name
---
# Colliding FM
EOF

# Write enabled config pointing at fixture KB
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/team-repo.git","local_path":"$KB"}]}}
JSON

# Run launch-spec --json
OUT="$(COOP_DIR="$CFG" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" launch-spec --json 2>&1)"
RC=$?
[ "$RC" -eq 0 ] || ko "launch-spec exited $RC: $OUT"

# Assert valid team skill is present in args
case "$OUT" in
  *"$KB/skills/valid-team-skill"*) ok "fixture team skill is included in launch-spec args" ;;
  *) ko "valid-team-skill missing from args: $OUT" ;;
esac

# Assert colliding dir skill is NOT present in args
case "$OUT" in
  *"$KB/skills/azure-devops"*) ko "colliding folder skill was NOT skipped: $OUT" ;;
  *) ok "folder collision skipped with first-party precedence" ;;
esac

# Assert colliding frontmatter skill is NOT present in args
case "$OUT" in
  *"$KB/skills/colliding-fm-skill"*) ko "colliding frontmatter skill was NOT skipped: $OUT" ;;
  *) ok "frontmatter collision skipped with first-party precedence" ;;
esac

# Assert disabled config produces NO team skills in args
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":false,"repos":[{"url":"https://example.com/team-repo.git","local_path":"$KB"}]}}
JSON

OUT_DISABLED="$(COOP_DIR="$CFG" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" launch-spec --json 2>&1)"
case "$OUT_DISABLED" in
  *"valid-team-skill"*) ko "disabled knowledge still loaded team skill" ;;
  *) ok "disabled knowledge config omits team skills" ;;
esac

# Assert absent knowledge config produces NO team skills in args
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1}
JSON

OUT_ABSENT="$(COOP_DIR="$CFG" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" launch-spec --json 2>&1)"
case "$OUT_ABSENT" in
  *"valid-team-skill"*) ko "absent knowledge config still loaded team skill" ;;
  *) ok "absent knowledge config omits team skills" ;;
esac

exit $fail
