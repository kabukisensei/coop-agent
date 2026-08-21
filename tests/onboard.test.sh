#!/usr/bin/env bash
#
# Tests for scripts/onboard.py (coop onboard / coop profile).
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
[ -z "$PY" ] && { echo "python3 required"; exit 1; }

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

COOP_DIR="$(mktemp -d)"
trap 'rm -rf "$COOP_DIR"' EXIT
export COOP_DIR

run_onboard() {
  HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" "$@"
}

# --- first-run onboarding ---------------------------------------------------------
out="$(printf 'Test User\n1\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
preset="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["communication"]["preset"])')"
[ "$name" = "Test User" ] && ok "onboard captures name" || ko "onboard name: $name"
[ "$preset" = "concise" ] && ok "onboard captures preset by number" || ko "onboard preset: $preset"

# --- profile show ---------------------------------------------------------------
show="$(HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile)"
case "$show" in *"Name: Test User"*) ok "profile shows name" ;; *) ko "profile show: $show" ;; esac
case "$show" in *"Communication: concise"*) ok "profile shows preset" ;; *) ko "profile show preset: $show" ;; esac

# --- profile edit ---------------------------------------------------------------
out="$(printf 'Updated\n3\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile --edit --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
preset="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["communication"]["preset"])')"
[ "$name" = "Updated" ] && ok "profile edit updates name" || ko "edit name: $name"
[ "$preset" = "teaching" ] && ok "profile edit updates preset" || ko "edit preset: $preset"

# --- profile reset --------------------------------------------------------------
HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile --reset >/dev/null 2>&1
rc=$?
[ "$rc" -eq 0 ] && ok "profile reset exits 0" || ko "profile reset exit: $rc"
[ ! -f "$COOP_DIR/.coop/user.json" ] && ok "profile reset removes user.json" || ko "user.json still exists"

# --- profile show without profile -----------------------------------------------
out="$(HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" profile 2>&1)"
rc=$?
[ "$rc" -ne 0 ] && ok "profile without user exits non-zero" || ko "expected non-zero exit, got $rc"
case "$out" in *"No COOP profile yet"*) ok "profile without user prints guidance" ;; *) ko "missing guidance: $out" ;; esac

# --- migration from legacy consultant_name in project.yml -----------------------
# Create a fake project with an old consultant_name and no local profile.
mig_dir="$COOP_DIR/migrate-test"
mkdir -p "$mig_dir/.coop"
cat > "$mig_dir/.coop/project.yml" <<'YAML'
profile:
  consultant_name: "Legacy Name"
  organization: "Cooptimize"
YAML
rm -f "$COOP_DIR/.coop/user.json"
out="$(cd "$mig_dir" && printf 'Y\n\n2\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
[ "$name" = "Legacy Name" ] && ok "onboard seeds profile from legacy consultant_name" || ko "migration name: $name"
out="$(printf 'bad/name\nGood Name\n1\n' | HOME="$COOP_DIR" "$PY" "$ROOT/scripts/onboard.py" onboard --json 2>/dev/null)"
name="$(printf '%s' "$out" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
[ "$name" = "Good Name" ] && ok "invalid name is rejected and re-asked" || ko "name after reject: $name"

exit $fail
