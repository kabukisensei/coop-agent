#!/usr/bin/env bash
# coop_fabric_python must discover side-by-side interpreters that are NOT on
# PATH (Python install manager / winget layouts) and reject incompatible ones.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." >/dev/null 2>&1 && pwd)"
. "$ROOT/lib/common.sh"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

fake_local="$T/appdata"
mkdir -p "$fake_local"

# Fail-stubs shadow every interpreter name the PATH-based probes try, so host
# interpreters cannot leak into the result; coreutils stay reachable via /bin.
for stub in python3.13 python3.12 python3 python py; do
  printf '#!/bin/sh\nexit 1\n' > "$T/bin-$stub"
  mv "$T/bin-$stub" "$T/$stub"
  chmod +x "$T/$stub"
done

make_fake_py() { # <path>
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<'SH'
#!/bin/sh
if [ "${1:-}" = "-c" ]; then printf '%s\n' "$COOP_FAKE_PY_VERSION"; exit 0; fi
exit 1
SH
  chmod +x "$1"
}

PATH="$T/bin:/usr/bin:/bin"   # stubbed interpreter names + coreutils only
export LOCALAPPDATA="$fake_local"
unset COOP_FABRIC_PYTHON

# 1. Python install manager layout: %LOCALAPPDATA%\Python\bin\python3.13.exe
export COOP_FAKE_PY_VERSION=3.13
py313="$fake_local/Python/bin/python3.13.exe"
make_fake_py "$py313"
found="$(coop_fabric_python)"
[ "$found" = "$py313" ] || { echo "  ✗ pymanager layout not discovered (got '$found')"; exit 1; }
echo "  ✓ %LOCALAPPDATA%/Python/bin side-by-side interpreter discovered"

# 2. An interpreter that reports 3.14 is NOT Fabric-compatible.
export COOP_FAKE_PY_VERSION=3.14
found="$(coop_fabric_python || true)"
[ -z "$found" ] || { echo "  ✗ 3.14 accepted as Fabric-compatible: '$found'"; exit 1; }
echo "  ✓ 3.14-only machine still reports no compatible interpreter"

# 3. winget user-scope layout: %LOCALAPPDATA%\Programs\Python\Python312\python.exe
rm -f "$py313"
export COOP_FAKE_PY_VERSION=3.12
py312="$fake_local/Programs/Python/Python312/python.exe"
make_fake_py "$py312"
found="$(coop_fabric_python)"
[ "$found" = "$py312" ] || { echo "  ✗ winget user-scope layout not discovered (got '$found')"; exit 1; }
echo "  ✓ %LOCALAPPDATA%/Programs/Python/Python31x layout discovered"
