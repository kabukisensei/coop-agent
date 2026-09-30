#!/usr/bin/env bash
# Users only ever get the release's tested versions. Outside `--edge`, every
# install or repair coop runs names the pin from config/release-manifest.json,
# and no hint tells a user to install `@latest`.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

# No @latest in product code. lib/mcp_config.py only detects the @latest
# placeholders older releases wrote, to migrate them away.
hits="$(grep -rn -I '@latest' "$ROOT/bin" "$ROOT/lib" "$ROOT/scripts" "$ROOT/extensions" "$ROOT/config" 2>/dev/null \
  | grep -v '/lib/mcp_config.py:' | grep -v '/node_modules/' || true)"
[ -z "$hits" ] && ok "no @latest in bin/, lib/, scripts/, extensions/ or config/" || ko "@latest found: $hits"

# `npm update -g <pkg>@<ver>` ignores the version and moves the tool to latest,
# so no product script runs it (comments may name it).
hits="$(grep -rn -I 'npm update -g' "$ROOT/bin" "$ROOT/lib" "$ROOT/scripts" 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*#' || true)"
[ -z "$hits" ] && ok "no product script runs npm update -g" || ko "npm update -g found: $hits"

# doctor --fix installs the coop tools and the Fabric CLI at their manifest pins.
grep -q 'pipx install "$t_spec"' "$ROOT/scripts/doctor.sh" \
  && ! grep -q 'pipx install "$t"' "$ROOT/scripts/doctor.sh" \
  && ok "doctor.sh --fix installs coop tools at their manifest pins" \
  || ko "doctor.sh --fix installs a coop tool without its manifest pin"
grep -q 'pipx install $tSpec' "$ROOT/scripts/doctor.ps1" \
  && ! grep -q 'pipx install $t ' "$ROOT/scripts/doctor.ps1" \
  && ok "doctor.ps1 --fix installs coop tools at their manifest pins" \
  || ko "doctor.ps1 --fix installs a coop tool without its manifest pin"
if grep -q 'fabric_spec=ms-fabric-cli' "$ROOT/scripts/doctor.sh" || grep -q "fabricSpec = 'ms-fabric-cli'" "$ROOT/scripts/doctor.ps1"; then
  ko "doctor --fix falls back to an unpinned ms-fabric-cli"
else
  ok "doctor --fix never falls back to an unpinned ms-fabric-cli"
fi

# Every install/repair pin the scripts read exists in the manifest.
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
if "$PY" - "$ROOT/config/release-manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
need = {"python_tools": ["ms-fabric-cli", "coop-data-doc", "coop-sql-review", "coop-dax-review", "fabric-cicd", "pyodbc"]}
missing = [f"{k}.{p}" for k, ps in need.items() for p in ps if not m.get(k, {}).get(p)]
assert m.get("pi", {}).get("version"), "pi.version"
assert not missing, missing
for section in ("extensions", "npm_tools", "mcp_servers", "python_tools"):
    for name, ver in m.get(section, {}).items():
        assert isinstance(ver, str) and ver[:1].isdigit() and not any(c in ver for c in "^~*<> "), f"{section}.{name}={ver!r} is not an exact version"
PY
then ok "the manifest pins Pi and every tool doctor --fix repairs, all to exact versions"
else ko "the manifest is missing a pin or holds a range"; fi

if [ "$fail" -ne 0 ]; then echo "  ✗ pin tests FAILED"; exit 1; fi
echo "  pin tests passed"
