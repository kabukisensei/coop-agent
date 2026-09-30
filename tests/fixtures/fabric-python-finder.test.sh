#!/usr/bin/env bash
# coop_fabric_bootstrap_python must discover side-by-side interpreters that are NOT on
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
mkdir -p "$T/bin"
for stub in python3.13 python3.12 python3 python py; do
  printf '#!/bin/sh\nexit 1\n' > "$T/bin/$stub"
  chmod +x "$T/bin/$stub"
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
found="$(coop_fabric_bootstrap_python)"
[ "$found" = "$py313" ] || { echo "  ✗ pymanager layout not discovered (got '$found')"; exit 1; }
echo "  ✓ %LOCALAPPDATA%/Python/bin side-by-side interpreter discovered"

# 2. An interpreter that reports 3.14 is NOT Fabric-compatible.
export COOP_FAKE_PY_VERSION=3.14
found="$(coop_fabric_bootstrap_python || true)"
[ -z "$found" ] || { echo "  ✗ 3.14 accepted as Fabric-compatible: '$found'"; exit 1; }
echo "  ✓ 3.14-only machine still reports no compatible interpreter"

# 3. winget user-scope layout: %LOCALAPPDATA%\Programs\Python\Python312\python.exe
rm -f "$py313"
export COOP_FAKE_PY_VERSION=3.12
py312="$fake_local/Programs/Python/Python312/python.exe"
make_fake_py "$py312"
found="$(coop_fabric_bootstrap_python)"
[ "$found" = "$py312" ] || { echo "  ✗ winget user-scope layout not discovered (got '$found')"; exit 1; }
echo "  ✓ %LOCALAPPDATA%/Programs/Python/Python31x layout discovered"

# 4. coop_version_lt: a two-part version reads as X.Y.0, never as X.Y.Y (a bug
#    that once let 3.14.2 pass the "older than 3.14" Fabric check).
for pair in '3.14.2 3.14 1' '3.14 3.14 1' '3.13.9 3.14 0' '3.10.5 3.10 1' '3.9.9 3.10 0' '22.18.1 22.19.0 0'; do
  set -- $pair
  rc=0; coop_version_lt "$1" "$2" || rc=$?
  [ "$rc" = "$3" ] || { echo "  ✗ coop_version_lt $1 $2 returned $rc, want $3"; exit 1; }
done
echo '  ✓ coop_version_lt treats "3.14" as 3.14.0 (3.14.2 is not older than 3.14)'

# 5. coop_pipx_fetch_python_flag: the flag pipx accepts for a standalone Python,
#    in that pipx's own spelling; nothing when it cannot fetch one.
make_fake_pipx() { # <path> <help-line>
  printf '#!/bin/sh\nif [ "$1 $2" = "install --help" ]; then echo "%s"; fi\nexit 0\n' "$2" > "$1"
  chmod +x "$1"
}
make_fake_pipx "$T/bin/pipx" '  --fetch-python {always,missing,never} | --fetch-missing-python'
[ "$(coop_pipx_fetch_python_flag)" = '--fetch-python=missing' ] || { echo '  ✗ pipx 1.12+ spelling not preferred'; exit 1; }
make_fake_pipx "$T/bin/pipx" '  --fetch-missing-python'
[ "$(coop_pipx_fetch_python_flag)" = '--fetch-missing-python' ] || { echo '  ✗ pipx 1.5-1.11 spelling not accepted'; exit 1; }
make_fake_pipx "$T/bin/pipx" '  --python PYTHON'
out="$(coop_pipx_fetch_python_flag)" && { echo "  ✗ a pipx without a fetch flag returned '$out'"; exit 1; }
[ -z "$out" ] || { echo "  ✗ a pipx without a fetch flag printed '$out'"; exit 1; }
# A pipx reachable only as `python -m pipx` is probed the same way.
cat > "$T/bin/python3" <<'SH'
#!/bin/sh
if [ "$1 $2 $3 $4" = "-m pipx install --help" ]; then echo '  --fetch-python {always,missing,never}'; fi
exit 0
SH
chmod +x "$T/bin/python3"
[ "$(coop_pipx_fetch_python_flag python3 -m pipx)" = '--fetch-python=missing' ] || { echo '  ✗ python -m pipx not probed'; exit 1; }
rm -f "$T/bin/pipx"
out="$(coop_pipx_fetch_python_flag)" && { echo '  ✗ a missing pipx reported a fetch flag'; exit 1; }
echo '  ✓ coop_pipx_fetch_python_flag reports --fetch-python=missing / --fetch-missing-python / nothing'

# 6. coop_fabric_pipx_plan: a local 3.10-3.13 wins; otherwise pipx's standalone
#    3.12 with that pipx's flag; nothing when neither exists (row 3 then decides).
printf '#!/bin/sh\nexit 1\n' > "$T/bin/python3"   # back to the fail-stub
export COOP_FAKE_PY_VERSION=3.12                     # py312 from case 3 is still in place
plan="$(coop_fabric_pipx_plan)" || { echo '  ✗ plan failed with a local 3.12 present'; exit 1; }
[ "$plan" = "$(printf '%s\t' "$py312")" ] || { echo "  ✗ plan with a local 3.12 gave '$plan'"; exit 1; }
rm -f "$py312"
out="$(coop_fabric_pipx_plan)" && { echo "  ✗ plan succeeded with no Python and no pipx: '$out'"; exit 1; }
make_fake_pipx "$T/bin/pipx" '  --fetch-python {always,missing,never}'
plan="$(coop_fabric_pipx_plan)" || { echo '  ✗ plan failed with a fetch-capable pipx'; exit 1; }
[ "$plan" = "$(printf '3.12\t--fetch-python=missing')" ] || { echo "  ✗ standalone plan gave '$plan'"; exit 1; }
echo '  ✓ coop_fabric_pipx_plan prefers a local 3.10-3.13, else pipx standalone 3.12, else nothing'
