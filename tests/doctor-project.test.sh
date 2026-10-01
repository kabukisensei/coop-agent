#!/usr/bin/env bash
#
# Tests for doctor's feature-aware project contract validation.
set -uo pipefail

CHECKOUT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
# Keep doctor's Azure sign-in probe (H2) away from any real az so the
# Project-contract assertions stay hermetic and fast.
COOP_SKIP_AZ=1; export COOP_SKIP_AZ

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Run doctor from a plain copy of this tree with no .git (#104): its once-a-day
# refresh fetches origin into the checkout it runs from, and a test must never
# touch the checkout running it. Dot entries other than the bundled .coop
# contract are git, CI and cache files, not runtime.
ROOT="$TMP/coop-agent"; mkdir "$ROOT"
cp -R "$CHECKOUT"/* "$CHECKOUT/.coop" "$ROOT/"
# Sandbox every home location doctor reads (#96): never the real ~/.coop,
# agent dir, `pi` state or mcp.json. Native Windows node and python find the
# home through USERPROFILE, so it gets the Windows spelling under Git Bash.
HOME="$TMP/home"; USERPROFILE="$HOME"; COOP_DIR="$HOME"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) USERPROFILE="$(cygpath -w "$HOME")" ;; esac
COOP_AGENT_DIR="$HOME/.coop/agent"; PI_CODING_AGENT_DIR="$COOP_AGENT_DIR"
mkdir -p "$COOP_AGENT_DIR"
export HOME USERPROFILE COOP_DIR COOP_AGENT_DIR PI_CODING_AGENT_DIR

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
case "$out" in
  *"is not a git checkout"*) ok "doctor runs from a copy of the tree, so it never fetches the checkout running the tests" ;;
  *) ko "doctor ran against a git checkout: the fixture must run a copy (#104)" ;;
esac

# --- legacy project health is visible and Doctor remains read-only ------------
mkdir -p "$TMP/legacy/.coop" "$TMP/legacy/.pi/skills/daily-logger"
cat > "$TMP/legacy/.coop/project.yml" <<'YAML'
profile:
  organization: Cooptimize
  default_branch: main
estate:
  mode: discovery
repositories: {}
standards:
  sql: docs/standards/sql-standards.md
tools:
  fabric_cli:
    enabled: false
  fabric_cicd:
    enabled: false
  tabular_editor_cli:
    enabled: false
YAML
printf '%s\n' 'Read docs/standards/sql-standards.md' > "$TMP/legacy/.pi/AGENTS.md"
printf '%s\n' '---' 'name: daily-logger' '---' > "$TMP/legacy/.pi/skills/daily-logger/SKILL.md"
before="$(python3 - "$TMP/legacy" <<'PY'
import hashlib, pathlib, sys
root=pathlib.Path(sys.argv[1])
for p in sorted(x for x in root.rglob('*') if x.is_file()):
 print(p.relative_to(root), hashlib.sha256(p.read_bytes()).hexdigest())
PY
)"
out="$(cd "$TMP/legacy" && "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
python3 - "$out" <<'PY' >/dev/null
import json, sys
checks=json.loads(sys.argv[1])["checks"]
names=[c["name"] for c in checks if c["section"] == "Project contract"]
for code in ("legacy_project_standard_override", "missing_project_standard", "legacy_pi_instruction", "project_skill_collision"):
    assert any(name.startswith(code + ":") for name in names), (code, names)
PY
[ "$?" -eq 0 ] && ok "Doctor reports every legacy project finding class" || ko "Doctor omitted a legacy project finding"
after="$(python3 - "$TMP/legacy" <<'PY'
import hashlib, pathlib, sys
root=pathlib.Path(sys.argv[1])
for p in sorted(x for x in root.rglob('*') if x.is_file()):
 print(p.relative_to(root), hashlib.sha256(p.read_bytes()).hexdigest())
PY
)"
[ "$before" = "$after" ] && ok "Doctor legacy diagnostics are read-only" || ko "Doctor mutated legacy project files"

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

# --- Azure SQL-only client: a missing Fabric CLI is optional, never red --------
# (master plan section 8 item 7). The row reads client.platform from the sandbox
# home's ~/.coop/config; fab is hidden from PATH so the "missing" branch runs
# whether or not the machine has it.
mkdir -p "$HOME/.coop"
printf '%s\n' '{"schema_version":1,"client":{"platform":"azure_sql"},"integrations":{"fabric":false,"fabric_sql_endpoint":false}}' > "$HOME/.coop/config"
# Drop every PATH directory that holds a fab (no symlinks: Git Bash copies them).
nofab=""
_old_ifs="$IFS"; IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  if [ -x "$d/fab" ] || [ -f "$d/fab.exe" ] || [ -f "$d/fab.cmd" ]; then continue; fi
  nofab="${nofab:+$nofab:}$d"
done
IFS="$_old_ifs"; unset _old_ifs
out="$(cd "$TMP/good" && PATH="$nofab" "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
python3 - "$out" <<'PY' >/dev/null
import sys, json
d = json.loads(sys.argv[1])
fab = [c for c in d["checks"] if c["section"] == "Microsoft Fabric CLI"]
assert fab, "Fabric CLI section missing"
assert not any(c["status"] == "bad" for c in fab), f"Azure SQL client got a red Fabric CLI row: {fab}"
assert any("Azure SQL client" in c["name"] for c in fab), f"optional-fab row missing: {fab}"
PY
rc=$?
[ "$rc" -eq 0 ] && ok "Azure SQL client: missing fab is reported as optional, not red" || ko "Azure SQL client still gets a red Fabric CLI row"
printf '%s\n' '{"schema_version":1,"client":{"platform":"fabric"},"integrations":{}}' > "$HOME/.coop/config"
out="$(cd "$TMP/good" && PATH="$nofab" "$ROOT/scripts/doctor.sh" --json 2>/dev/null)"
echo "$out" | grep -q '"fab missing"' && ok "Fabric client: missing fab stays red" || ko "Fabric client lost the red fab row"
rm -f "$HOME/.coop/config"

exit $fail
