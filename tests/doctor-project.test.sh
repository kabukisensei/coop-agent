#!/usr/bin/env bash
#
# Tests for doctor's feature-aware project contract validation.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- valid minimal contract (Fabric disabled) passes validation ---------------
mkdir -p "$TMP/good/.coop"
cat > "$TMP/good/.coop/project.yml" <<'YAML'
profile:
  organization: Cooptimize
  default_branch: main
repositories:
  good:
    local_path: /tmp/good
    default_branch: main
tools:
  fabric_cli:
    enabled: false
  fabric_cicd:
    enabled: false
  tabular_editor_cli:
    enabled: false
YAML

out="$(cd "$TMP/good" && "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
python3 - "$out" <<'PY' >/dev/null
import sys, json
d = json.loads(sys.argv[1])
proj = [c for c in d["checks"] if c["section"] == "Project contract"]
assert len(proj) >= 1, "Project contract section missing"
assert any("project.yml found" in c["name"] and c["status"] == "ok" for c in proj), "project.yml found not ok"
assert not any(c["status"] == "warn" for c in proj), f"unexpected project warning: {proj}"
PY
rc=$?
[ "$rc" -eq 0 ] && ok "Project contract section present and clean" || ko "Project contract validation failed"

# --- missing organization / branch / repo -------------------------------------
mkdir -p "$TMP/bad/.coop"
cat > "$TMP/bad/.coop/project.yml" <<'YAML'
profile:
  organization: ""
tools:
  fabric_cli:
    enabled: false
  tabular_editor_cli:
    enabled: false
YAML

out="$(cd "$TMP/bad" && "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
echo "$out" | grep -q 'organization is empty' && ok "flags empty organization" || ko "did not flag empty organization"
echo "$out" | grep -q 'default_branch is empty' && ok "flags empty default_branch" || ko "did not flag empty default_branch"
echo "$out" | grep -q 'no repositories configured' && ok "flags missing repositories" || ko "did not flag missing repositories"

# --- explicit discovery mode needs no local repository -----------------------
mkdir -p "$TMP/discovery/.coop"
cat > "$TMP/discovery/.coop/project.yml" <<'YAML'
profile:
  organization: Cooptimize
  default_branch: main
estate:
  mode: discovery
repositories: {}
tools:
  fabric_cli:
    enabled: false
  fabric_cicd:
    enabled: false
  tabular_editor_cli:
    enabled: false
YAML

out="$(cd "$TMP/discovery" && "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
echo "$out" | grep -q 'no repositories configured' && ko "warned about repositories in discovery mode" || ok "accepts repository-free discovery mode"

# --- Fabric enabled but tenant missing ----------------------------------------
mkdir -p "$TMP/fabric/.coop"
cat > "$TMP/fabric/.coop/project.yml" <<'YAML'
profile:
  organization: Cooptimize
  default_branch: main
repositories:
  fab:
    local_path: /tmp/fabric
    default_branch: main
tools:
  fabric_cli:
    enabled: true
  tabular_editor_cli:
    enabled: false
YAML

out="$(cd "$TMP/fabric" && "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
echo "$out" | grep -q 'tenant_id is empty' && ok "flags missing fabric tenant_id when Fabric enabled" || ko "did not flag missing tenant_id"

# --- Tabular Editor enabled but path missing ----------------------------------
mkdir -p "$TMP/te/.coop"
cat > "$TMP/te/.coop/project.yml" <<'YAML'
profile:
  organization: Cooptimize
  default_branch: main
repositories:
  t:
    local_path: /tmp/te
    default_branch: main
tools:
  tabular_editor_cli:
    enabled: true
YAML

out="$(cd "$TMP/te" && "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
echo "$out" | grep -q 'executable_path not set' && ok "flags missing TE path when Tabular Editor enabled" || ko "did not flag missing TE path"

exit $fail
