#!/usr/bin/env bash
# Fresh install must add a Fabric-compatible Python even when Python 3.14 exists.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

BIN="$T/bin"
RUNNER_BIN="$T/runner-bin"
KEG="$T/python312"
CALLS="$T/calls"
REAL_NODE="$(command -v node)"
mkdir -p "$BIN" "$RUNNER_BIN" "$KEG/libexec/bin" "$T/home/.local/bin" "$T/pipx-home" "$T/pipx-bin" "$T/agent" "$T/localappdata"

cat > "$BIN/uname" <<'SH'
#!/bin/sh
echo "${COOP_TEST_UNAME:-Darwin}"
SH
cat > "$BIN/python3" <<'SH'
#!/bin/sh
case "$1" in
  --version) echo "Python ${COOP_TEST_GENERIC_PY_VERSION}" ;;
  -c) echo "${COOP_TEST_GENERIC_PY_VERSION%.*}" ;;
  -m)
    case "$2 $3" in
      'site --user-base') echo "$HOME/.local" ;;
    esac
    ;;
esac
exit 0
SH
# Shadow every PATH-based Python name coop_fabric_python probes. The runner
# directory below intentionally contains a compatible Python so this fixture
# fails deterministically if any candidate leaks past the stubs.
for _py_name in python3.10 python3.11 python3.12 python3.13 python; do
  ln -s python3 "$BIN/$_py_name"
done
cat > "$BIN/py" <<'SH'
#!/bin/sh
exit 1
SH
cat > "$BIN/winget" <<'SH'
#!/bin/sh
exit 1
SH
cat > "$RUNNER_BIN/python" <<'SH'
#!/bin/sh
case "$1" in
  --version) echo 'Python 3.11.9' ;;
  -c) echo '3.11' ;;
esac
exit 0
SH
cat > "$KEG/libexec/bin/python3" <<'SH'
#!/bin/sh
case "$1" in
  --version) echo 'Python 3.12.9' ;;
  -c) echo '3.12' ;;
  -m)
    case "$2 $3" in
      'site --user-base') echo "$HOME/.local" ;;
    esac
    ;;
esac
exit 0
SH
cat > "$BIN/brew" <<'SH'
#!/bin/sh
echo "BREW $*" >> "$COOP_TEST_CALLS"
if [ "$1 $2" = 'install python@3.12' ] && [ -n "${COOP_FABRIC_PYTHON:-}" ]; then
  mkdir -p "$(dirname "$COOP_FABRIC_PYTHON")"
  cp "$COOP_TEST_KEG/libexec/bin/python3" "$COOP_FABRIC_PYTHON"
  chmod +x "$COOP_FABRIC_PYTHON"
fi
if [ "$1" = "--prefix" ]; then echo "$COOP_TEST_KEG"; fi
exit 0
SH
cat > "$BIN/git" <<'SH'
#!/bin/sh
echo 'git version 2.50.0'
SH
cat > "$BIN/node" <<'SH'
#!/bin/sh
if [ "$1" = '--version' ]; then echo 'v22.19.0'; exit 0; fi
exec "$COOP_TEST_REAL_NODE" "$@"
SH
cat > "$BIN/npm" <<'SH'
#!/bin/sh
if [ "$1 $2" = 'prefix -g' ]; then dirname "$(dirname "$0")"; fi
exit 0
SH
cat > "$BIN/pi" <<'SH'
#!/bin/sh
if [ "$1" = '--version' ]; then echo 'pi 0.84.3'; fi
exit 0
SH
cat > "$BIN/pipx" <<'SH'
#!/bin/sh
echo "PIPX $*" >> "$COOP_TEST_CALLS"
if [ "$1 $2" = 'install --help' ]; then
  echo '--fetch-python {always,missing,never}'
  exit 0
fi
if [ "$1" = 'list' ]; then
  echo 'package coop-data-doc 1.1.1'
  echo 'package coop-sql-review 0.15.2'
  echo 'package coop-dax-review 0.22.0'
  echo 'package ms-fabric-cli 1.7.0'
fi
exit 0
SH
cat > "$BIN/fab" <<'SH'
#!/bin/sh
echo 'fab version 1.7.0'
SH
cat > "$BIN/az" <<'SH'
#!/bin/sh
echo 'azure-cli 2.80.0'
SH
chmod +x "$BIN"/* "$RUNNER_BIN/python" "$KEG/libexec/bin/python3"

export HOME="$T/home" COOP_DIR="$T/coop-dir" PIPX_HOME="$T/pipx-home" PIPX_BIN_DIR="$T/pipx-bin"
export PI_CODING_AGENT_DIR="$T/agent" COOP_AGENT_DIR="$T/agent" COOP_NO_ONBOARD=1
export LOCALAPPDATA="$T/localappdata"
export COOP_TEST_CALLS="$CALLS" COOP_TEST_KEG="$KEG" COOP_TEST_REAL_NODE="$REAL_NODE"
COOP_TEST_STUB_PATH="$BIN"; export COOP_TEST_STUB_PATH
unset COOP_FABRIC_PYTHON COOP_TEST_UNAME
PATH="$BIN:$RUNNER_BIN:/usr/bin:/bin"; export PATH

# Python 3.14 satisfies general Coop scripting but not ms-fabric-cli. The
# installer must bootstrap 3.12 and pass that interpreter explicitly to pipx.
: > "$CALLS"
OUT="$T/install.out"
FABRIC_PY="$KEG/bin/python3"
if ! COOP_TEST_GENERIC_PY_VERSION=3.14.6 COOP_FABRIC_PYTHON="$FABRIC_PY" COOP_FLEET_TEST_MODE=1 \
  bash "$ROOT/scripts/install.sh" --force >"$OUT" 2>&1; then
  echo 'Python 3.14-only install fixture failed unexpectedly'; tail -40 "$OUT"; cat "$CALLS"; exit 1
fi
grep -F 'BREW install python@3.12' "$CALLS" >/dev/null \
  || { echo 'Python 3.14-only install did not bootstrap python@3.12'; cat "$CALLS"; exit 1; }
grep -F "PIPX install --force --python $FABRIC_PY ms-fabric-cli==1.7.0" "$CALLS" >/dev/null \
  || { echo 'Fabric CLI did not use the bootstrapped compatible Python'; cat "$CALLS"; exit 1; }
echo '  ✓ Python 3.14-only install bootstraps and uses a compatible Fabric interpreter'

# A compatible generic interpreter must remain untouched; no redundant Python
# package-manager operation should occur.
: > "$CALLS"
if ! COOP_TEST_GENERIC_PY_VERSION=3.13.7 COOP_FLEET_TEST_MODE=1 \
  bash "$ROOT/scripts/install.sh" --force >"$OUT" 2>&1; then
  echo 'compatible-Python install fixture failed unexpectedly'; tail -40 "$OUT"; cat "$CALLS"; exit 1
fi
if grep -F 'BREW install python@' "$CALLS" >/dev/null; then
  echo 'compatible Python triggered an unnecessary Python install'; cat "$CALLS"; exit 1
fi
grep -F "PIPX install --force --python $BIN/python3.13 ms-fabric-cli==1.7.0" "$CALLS" >/dev/null \
  || { echo 'Fabric CLI did not retain the existing compatible Python'; cat "$CALLS"; exit 1; }
echo '  ✓ existing compatible Python is retained without redundant installation'

# A Windows VM with Python 3.14 but no winget/py/pymanager must fall back to
# pipx's own standalone-Python cache instead of requiring a system installer.
: > "$CALLS"
if ! COOP_TEST_UNAME=MINGW64_NT COOP_TEST_GENERIC_PY_VERSION=3.14.6 COOP_FLEET_TEST_MODE=1 \
  bash "$ROOT/scripts/install.sh" --force >"$OUT" 2>&1; then
  echo 'Windows Python 3.14-only standalone-fetch fixture failed unexpectedly'; tail -40 "$OUT"; cat "$CALLS"; exit 1
fi
grep -F 'PIPX install --force --fetch-python=missing --python 3.12 ms-fabric-cli==1.7.0' "$CALLS" >/dev/null \
  || { echo 'Fabric CLI did not fetch standalone Python 3.12 without Windows installers'; cat "$CALLS"; exit 1; }
echo '  ✓ Windows install fetches standalone Python 3.12 without winget/py/pymanager'

: > "$CALLS"
if ! COOP_TEST_UNAME=MINGW64_NT COOP_TEST_GENERIC_PY_VERSION=3.14.6 COOP_FLEET_TEST_MODE=1 \
  bash "$ROOT/scripts/update.sh" >"$OUT" 2>&1; then
  echo 'Windows Python 3.14-only update fixture failed unexpectedly'; tail -40 "$OUT"; cat "$CALLS"; exit 1
fi
grep -F 'PIPX install --force --fetch-python=missing --python 3.12 ms-fabric-cli==1.7.0' "$CALLS" >/dev/null \
  || { echo 'Updater did not rebuild Fabric CLI with standalone Python 3.12'; cat "$CALLS"; exit 1; }
grep -F 'PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force' "$CALLS" >/dev/null \
  || { echo 'Updater did not reinject fabric-cicd after rebuilding Fabric CLI'; cat "$CALLS"; exit 1; }
echo '  ✓ Windows update repairs an existing Python 3.14 Fabric environment'
