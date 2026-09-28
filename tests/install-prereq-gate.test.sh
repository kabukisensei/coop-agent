#!/usr/bin/env bash
# H1: `coop install` checks every prerequisite first, in order, prints the exact
# command for each missing one, and stops before installing anything. Doctor
# reports the same rows with the same text. Stubs only; nothing is installed.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

BIN="$T/bin"; NODEBIN="$T/node-bin"; CALLS="$T/calls"; OUT="$T/out"
REAL_NODE="$(command -v node)"
mkdir -p "$BIN" "$NODEBIN" "$T/home" "$T/agent"

stub() { printf '#!/bin/sh\n%s\n' "$2" > "$BIN/$1"; chmod +x "$BIN/$1"; }
stub uname 'echo "${COOP_TEST_UNAME:-Darwin}"'
stub git "echo 'git version 2.50.0'"
stub az "echo 'azure-cli 2.80.0'"
stub pipx 'echo "PIPX $*" >> "$COOP_TEST_CALLS"; [ "$1" = --version ] && echo 1.7.1; exit 0'
stub npm 'echo "NPM $*" >> "$COOP_TEST_CALLS"; exit 0'
stub winget 'echo "WINGET $*" >> "$COOP_TEST_CALLS"; exit 0'
stub brew 'echo "BREW $*" >> "$COOP_TEST_CALLS"; exit 0'
stub py 'exit 1'
# "Python missing": every name the resolvers probe answers with nothing, like
# the Windows Store stub, so a host interpreter cannot leak in.
for n in python3 python python3.10 python3.11 python3.12 python3.13; do stub "$n" 'exit 0'; done
cat > "$NODEBIN/node" <<'SH'
#!/bin/sh
if [ "$1" = '--version' ]; then echo "v${COOP_TEST_NODE_VERSION:-22.19.0}"; exit 0; fi
exec "$COOP_TEST_REAL_NODE" "$@"
SH
chmod +x "$NODEBIN/node"

if PATH="$BIN:/usr/bin:/bin" command -v node >/dev/null 2>&1; then
  echo '  --  a system node on /usr/bin or /bin; "Node missing" gate fixture skipped'
  exit 0
fi

export HOME="$T/home" COOP_DIR="$T/coop-dir" COOP_AGENT_DIR="$T/agent" PI_CODING_AGENT_DIR="$T/agent"
export COOP_NO_ONBOARD=1 COOP_FLEET_TEST_MODE=1 COOP_TEST_CALLS="$CALLS" COOP_TEST_REAL_NODE="$REAL_NODE"
COOP_TEST_STUB_PATH="$BIN"; export COOP_TEST_STUB_PATH
unset LOCALAPPDATA COOP_FABRIC_PYTHON COOP_TEST_UNAME 2>/dev/null || true

fail() { echo "  ✗ $1"; echo '--- output ---'; cat "$OUT"; echo '--- calls ---'; cat "$CALLS"; exit 1; }
has() { grep -F -- "$1" "$OUT" >/dev/null || fail "missing from output: $1"; }
run_install() { # <path> [args...] -> sets RC
  local p="$1"; shift
  : > "$CALLS"; RC=0
  PATH="$p" bash "$ROOT/scripts/install.sh" "$@" >"$OUT" 2>&1 || RC=$?
}
nothing_installed() {
  if grep -E '^(PIPX install|NPM install|WINGET|BREW)' "$CALLS" >/dev/null; then fail "$1: something was installed"; fi
  if grep -F '2/9' "$OUT" >/dev/null; then fail "$1: install went past the prerequisite stage"; fi
}

# 1. Fresh Windows machine without Node and without Python (Git Bash twin):
#    stop at the checklist with both winget commands, install nothing.
COOP_TEST_UNAME=MINGW64_NT run_install "$BIN:/usr/bin:/bin"
[ "$RC" -ne 0 ] || fail 'Windows: install without Node/Python exited 0'
has '✓ 1. Git  (2.50.0)'
has '✗ 2. Node.js 22.19.0 or newer  (not found)'
has 'winget install --id OpenJS.NodeJS.LTS -e'
has '✗ 3. Python 3.10-3.13 (3.12 recommended)  (not found)'
has 'winget install --id Python.Python.3.12 -e'
has '✓ 5. Azure CLI'
has '2 required prerequisite(s) missing. Install the ✗ rows above in that order, open a NEW terminal, then run: coop install'
nothing_installed 'Windows'
# Dependency order: Git, Node, Python, pipx, Azure CLI, ODBC, Tabular Editor.
order="$(grep -oE '[✓✗!] [1-7]\. ' "$OUT" | grep -oE '[1-7]' | tr -d '\n')"
[ "$order" = 1234567 ] || fail "rows out of order: $order"
echo '  ✓ Windows without Node/Python stops at the ordered checklist with both winget commands'

# 2. macOS, same machine: brew commands, still nothing installed.
run_install "$BIN:/usr/bin:/bin"
[ "$RC" -ne 0 ] || fail 'macOS: install without Node/Python exited 0'
has 'brew install node'
has 'brew install python@3.12'
nothing_installed 'macOS'
echo '  ✓ macOS without Node/Python stops with the brew commands'

# 3. The Node minimum comes from config/release-manifest.json, not a constant.
sed 's/"min": "22.19.0"/"min": "99.0.0"/' "$ROOT/config/release-manifest.json" > "$T/manifest.json"
grep -F '"min": "99.0.0"' "$T/manifest.json" >/dev/null || fail 'fixture manifest edit did not apply'
COOP_RELEASE_MANIFEST="$T/manifest.json" run_install "$NODEBIN:$BIN:/usr/bin:/bin"
has '✗ 2. Node.js 99.0.0 or newer  (22.19.0 is older than 99.0.0)'
nothing_installed 'manifest node.min'
echo '  ✓ Node minimum is read from the release manifest'

# 4. --prereqs auto runs the printed commands visibly, re-checks, and still
#    asks for a new terminal.
run_install "$BIN:/usr/bin:/bin" --prereqs auto
[ "$RC" -ne 0 ] || fail '--prereqs auto exited 0 instead of asking for a new terminal'
grep -F 'BREW install node' "$CALLS" >/dev/null || fail '--prereqs auto did not run brew install node'
grep -F 'BREW install python@3.12' "$CALLS" >/dev/null || fail '--prereqs auto did not run brew install python@3.12'
has 'running: brew install node'
has 'Prerequisites (re-checked)'
has 'Open a NEW terminal so the new tools are on PATH, then run: coop install'
grep -F '2/9' "$OUT" >/dev/null && fail '--prereqs auto continued in the same terminal'
echo '  ✓ --prereqs auto installs visibly, re-checks, and requires a new terminal'

# 5. --no-prereqs keeps the old "warn and continue" escape hatch.
run_install "$BIN:/usr/bin:/bin" --no-prereqs
has '2 required prerequisite(s) missing (--no-prereqs: continuing anyway)'
has '2/9'
echo '  ✓ --no-prereqs reports the table and continues'

# 6. Doctor shows the same rows with the same text and fails on them.
: > "$CALLS"; RC=0
PATH="$BIN:/usr/bin:/bin" bash "$ROOT/scripts/doctor.sh" >"$OUT" 2>&1 || RC=$?
[ "$RC" -ne 0 ] || fail 'doctor exited 0 with Node and Python missing'
has '✗ 2. Node.js 22.19.0 or newer  (not found) — brew install node'
has '✗ 3. Python 3.10-3.13 (3.12 recommended)  (not found) — brew install python@3.12'
echo '  ✓ doctor reports the same prerequisite rows as install'
