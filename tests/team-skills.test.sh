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
  *"knowledge/team-repo/skills/valid-team-skill"*) ok "fixture team skill is included in launch-spec args" ;;
  *) ko "valid-team-skill missing from args: $OUT" ;;
esac

# Assert colliding dir skill is NOT present in args
case "$OUT" in
  *"knowledge/team-repo/skills/azure-devops"*) ko "colliding folder skill was NOT skipped: $OUT" ;;
  *) ok "folder collision skipped with first-party precedence" ;;
esac

# Assert colliding frontmatter skill is NOT present in args
case "$OUT" in
  *"knowledge/team-repo/skills/colliding-fm-skill"*) ko "colliding frontmatter skill was NOT skipped: $OUT" ;;
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

# 4. Multi-repo test: a second fixture repo also contributes skills to launch-spec (Phase 2.5)
KB2="$TMP/knowledge/second-repo"
mkdir -p "$KB2/skills/second-team-skill"
cat > "$KB2/skills/second-team-skill/SKILL.md" <<'EOF'
---
name: second-team-skill
description: Second team skill
---
# Second Team Skill
EOF

cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/team-repo.git","local_path":"$KB"},{"url":"https://example.com/second-repo.git","local_path":"$KB2"}]}}
JSON

OUT_MULTI="$(COOP_DIR="$CFG" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" launch-spec --json 2>&1)"
RC=$?
[ "$RC" -eq 0 ] || ko "launch-spec multi-repo exited $RC: $OUT_MULTI"
case "$OUT_MULTI" in
  *"knowledge/team-repo/skills/valid-team-skill"*) ok "multi-repo: first repo skill included in launch-spec" ;;
  *) ko "multi-repo: first repo skill missing: $OUT_MULTI" ;;
esac
case "$OUT_MULTI" in
  *"knowledge/second-repo/skills/second-team-skill"*) ok "multi-repo: second repo skill included in launch-spec" ;;
  *) ko "multi-repo: second repo skill missing: $OUT_MULTI" ;;
esac

# ============================================================================
# Invalid-team-skill regression (review finding 2): an optional external skill
# with no parseable frontmatter name must never abort startup, and stdout must
# stay clean JSON (diagnostics on stderr only).
# ============================================================================

# Helper: run launch-spec --json with stdout/stderr captured SEPARATELY.
# Env: KB_FIX (knowledge repo root). Returns JSON on stdout file $TMP/spec.json,
# diagnostics in $TMP/spec.err, rc in $SPEC_RC.
run_spec_separate() {
  COOP_DIR="$CFG" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" launch-spec --json \
    > "$TMP/spec.json" 2> "$TMP/spec.err"
  SPEC_RC=$?
}

assert_valid_json() {
  python3 - "$TMP/spec.json" <<'PY' >/dev/null 2>&1
import json, sys
d = json.load(open(sys.argv[1]))
assert isinstance(d, dict)
PY
}

# --- a missing-name skill ALONE must not abort the launcher --------------------
KB3="$TMP/knowledge/no-name-repo"
mkdir -p "$KB3/skills/zzzz-invalid-final"
cat > "$KB3/skills/zzzz-invalid-final/SKILL.md" <<'EOF'
# No frontmatter at all — invalid external skill
EOF
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/no-name.git","local_path":"$KB3"}]}}
JSON
run_spec_separate
[ "$SPEC_RC" -eq 0 ] && ok "missing-name skill alone: launcher exits 0" || ko "missing-name alone aborted: rc=$SPEC_RC err=$(cat "$TMP/spec.err")"
assert_valid_json && ok "missing-name alone: stdout is valid JSON" || ko "stdout contaminated: $(head -c 200 "$TMP/spec.json")"
case "$(cat "$TMP/spec.json")" in
  *"zzzz-invalid-final"*) ko "invalid skill still in launch args" ;;
  *) ok "invalid skill absent from launch args" ;;
esac
case "$(cat "$TMP/spec.err")" in
  *"missing frontmatter name"*) ok "warning emitted on stderr" ;;
  *) ko "no warning on stderr: $(cat "$TMP/spec.err")" ;;
esac

# --- valid skill + zzzz-invalid-final (alphabetically LAST) --------------------
KB4="$TMP/knowledge/mixed-repo"
mkdir -p "$KB4/skills/aaa-valid-skill" "$KB4/skills/zzzz-invalid-final"
cat > "$KB4/skills/aaa-valid-skill/SKILL.md" <<'EOF'
---
name: aaa-valid-skill
description: Valid
---
# Valid
EOF
cat > "$KB4/skills/zzzz-invalid-final/SKILL.md" <<'EOF'
---
description: has a description but no name field
---
# Invalid final skill
EOF
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/mixed.git","local_path":"$KB4"}]}}
JSON
run_spec_separate
[ "$SPEC_RC" -eq 0 ] && ok "valid + invalid-final: launcher exits 0" || ko "invalid-final aborted startup: rc=$SPEC_RC err=$(cat "$TMP/spec.err")"
assert_valid_json && ok "valid + invalid-final: stdout is valid JSON" || ko "stdout contaminated"
case "$(cat "$TMP/spec.json")" in
  *"aaa-valid-skill"*) ok "valid skill still loaded alongside invalid-final" ;;
  *) ko "valid skill lost: $(cat "$TMP/spec.json")" ;;
esac
case "$(cat "$TMP/spec.json")" in
  *"zzzz-invalid-final"*) ko "invalid-final present in args" ;;
  *) ok "invalid-final absent from args" ;;
esac
case "$(cat "$TMP/spec.err")" in
  *"missing frontmatter name"*) ok "invalid-final warned on stderr" ;;
  *) ko "no invalid-final warning" ;;
esac

# --- exact skill arguments: only the valid skill is added ----------------------
nargs="$(python3 - "$TMP/spec.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
args = d.get("args") or d.get("pi_args") or []
print(sum(1 for a in args if "mixed-repo/skills/" in str(a)))
PY
)"
[ "$nargs" = "1" ] && ok "exactly one team --skill argument (the valid one)" || ko "team skill arg count: $nargs"

# --- no skill directories at all ------------------------------------------------
KB5="$TMP/knowledge/empty-repo"
mkdir -p "$KB5"
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/empty.git","local_path":"$KB5"}]}}
JSON
run_spec_separate
[ "$SPEC_RC" -eq 0 ] && ok "no skill dirs: launcher exits 0" || ko "empty repo aborted: rc=$SPEC_RC"

# --- duplicate team names across repositories: first wins, second skipped ------
KB6="$TMP/knowledge/dup-repo-a"
KB7="$TMP/knowledge/dup-repo-b"
mkdir -p "$KB6/skills/shared-skill" "$KB7/skills/shared-skill"
cat > "$KB6/skills/shared-skill/SKILL.md" <<'EOF'
---
name: shared-skill
description: First copy
---
# First
EOF
cat > "$KB7/skills/shared-skill/SKILL.md" <<'EOF'
---
name: shared-skill
description: Second copy
---
# Second
EOF
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"https://example.com/a.git","local_path":"$KB6"},{"url":"https://example.com/b.git","local_path":"$KB7"}]}}
JSON
run_spec_separate
[ "$SPEC_RC" -eq 0 ] && ok "duplicate names: launcher exits 0" || ko "dup aborted: rc=$SPEC_RC"
case "$(cat "$TMP/spec.json")" in
  *"dup-repo-a"*"shared-skill"*) ok "first repository's copy loaded" ;; *) ko "first copy missing" ;;
esac
case "$(cat "$TMP/spec.json")" in
  *"dup-repo-b"*) ko "second repository's duplicate NOT skipped" ;; *) ok "second repository's duplicate skipped (first wins)" ;;
esac

exit $fail

