#!/usr/bin/env bash
#
# ADO tooling regression tests: iter_clients, build_client_model, append_block.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

PY="$(command -v python3 || command -v python)" || fail "python required for this test"

# --- 1. iter_clients coalesces stale_days: null to the default ---
"$PY" - <<PYEOF
import sys, os
sys.path.insert(0, os.path.join("$ROOT", "scripts"))
import ado_lib as A

cfg = {
  "defaults": {"stale_days": 21},
  "clients": [
    {"key": "a", "stale_days": None},
    {"key": "b", "stale_days": 30},
    {"key": "c"},
  ]
}
clients = list(A.iter_clients(cfg))
assert clients[0]["stale_days"] == 21, clients[0]
assert clients[1]["stale_days"] == 30, clients[1]
assert clients[2]["stale_days"] == 21, clients[2]
PYEOF
[ $? -eq 0 ] || fail "iter_clients stale_days coalescing failed"
pass "iter_clients coalesces null stale_days to default"

# --- 2. build_client_model raises AdoError when project is missing ---
"$PY" - <<PYEOF
import sys, os, importlib.util
sys.path.insert(0, os.path.join("$ROOT", "scripts"))
import ado_lib as A

spec = importlib.util.spec_from_file_location("ado_digest", os.path.join("$ROOT", "scripts", "ado-digest.py"))
ado_digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ado_digest)

cfg = {"key": "bad", "org": "https://dev.azure.com/x"}
try:
    ado_digest.build_client_model(cfg, None, 14)
except A.AdoError as e:
    assert "no project" in str(e).lower(), e
else:
    raise AssertionError("expected AdoError for missing project")
PYEOF
[ $? -eq 0 ] || fail "build_client_model missing-project check failed"
pass "build_client_model raises AdoError on missing project"

# --- 3. append_block writes atomically and detects existing clients key via YAML ---
"$PY" - <<PYEOF
import sys, os, tempfile, importlib.util
sys.path.insert(0, os.path.join("$ROOT", "scripts"))

spec = importlib.util.spec_from_file_location("ado_onboard", os.path.join("$ROOT", "scripts", "ado-onboard.py"))
ado_onboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ado_onboard)

tmp = tempfile.mkdtemp()
# Case A: file with only defaults should get a clients: header added.
p1 = os.path.join(tmp, "clients1.yml")
with open(p1, "w", encoding="utf-8") as f:
    f.write("defaults:\n  stale_days: 14\n")
ado_onboard.append_block(p1, "- key: new1\n")
data = open(p1).read()
assert data.count("clients:") == 1, data
assert "key: new1" in data, data

# Case B: file that already has clients: should NOT get a second header.
p2 = os.path.join(tmp, "clients2.yml")
with open(p2, "w", encoding="utf-8") as f:
    f.write("clients:\n- key: existing\n")
ado_onboard.append_block(p2, "- key: new2\n")
data = open(p2).read()
assert data.count("clients:") == 1, data
assert "key: existing" in data, data
assert "key: new2" in data, data

# Case C: a comment containing 'clients:' should not be treated as the key.
p3 = os.path.join(tmp, "clients3.yml")
with open(p3, "w", encoding="utf-8") as f:
    f.write("# clients: not really\ndefaults:\n  stale_days: 14\n")
ado_onboard.append_block(p3, "- key: new3\n")
data = open(p3).read()
assert data.count("clients:") == 2, data
assert "# clients:" in data, data
PYEOF
[ $? -eq 0 ] || fail "append_block tests failed"
pass "append_block detects existing clients key and writes atomically"

printf '  %s\n' "ado tests passed"
