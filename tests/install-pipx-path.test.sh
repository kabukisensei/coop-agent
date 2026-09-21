#!/usr/bin/env bash
# The pipx launcher from `pip install --user pipx` lands in the VERSIONED
# per-user Scripts dir on Windows (%APPDATA%\Python\Python312\Scripts), NOT
# %APPDATA%\Python\Scripts — so a fresh-user Windows install must resolve it
# via sysconfig's nt_user scheme or step 4/9 (Fabric CLI) cannot see pipx
# and both the --fetch-python fallback and bare `pipx` calls fail.
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

# Windows twin resolves the real per-user scripts dir from sysconfig.
grep -q "sysconfig.get_path('scripts', 'nt_user')" "$ROOT/scripts/install.ps1" \
  || { echo "FAIL: install.ps1 must resolve the pipx launcher dir via sysconfig nt_user"; exit 1; }

# The nonexistent %APPDATA%\Python\Scripts construction must stay gone.
if grep -q "Join-Path \$base 'Scripts'" "$ROOT/scripts/install.ps1"; then
  echo "FAIL: install.ps1 still joins user-base\\Scripts (that dir does not exist on Windows)"
  exit 1
fi

# POSIX twin keeps its correct user-base/bin prepend (pip --user scripts land in ~/.local/bin).
grep -q 'PATH="\$_ub/bin:\$PATH"' "$ROOT/scripts/install.sh" \
  || { echo "FAIL: install.sh lost its user-base/bin PATH prepend"; exit 1; }

echo "✓ pipx launcher PATH resolution is correct on both twins"
