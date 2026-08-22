#!/usr/bin/env bash
# Execute normal install/update/sync fleet paths with offline stubs and assert exact specs.
set -euo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
HOME="$D/home"; STUB="$HOME/.local/bin"; MARKER="$D/calls"; mkdir -p "$STUB"; export HOME MARKER
REAL_NODE="$(command -v node)"; REAL_PY="$(command -v python3 2>/dev/null || command -v python)"
cat > "$STUB/pi" <<'SH'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'pi 0.80.2'; exit 0; }
echo "PI $*" >> "$MARKER"; exit 0
SH
cat > "$STUB/npm" <<'SH'
#!/bin/sh
[ "$1 $2" = "prefix -g" ] && { dirname "$(dirname "$0")"; exit 0; }
[ "$1" = "view" ] && { echo '0.80.2'; exit 0; }
echo "NPM $*" >> "$MARKER"; exit 0
SH
cat > "$STUB/pipx" <<'SH'
#!/bin/sh
if [ "$1" = "list" ]; then
  echo 'package coop-data-doc 1.1.0'; echo 'package coop-sql-review 0.15.2'; echo 'package coop-dax-review 0.22.0'; echo 'package ms-fabric-cli 1.6.1'; exit 0
fi
echo "PIPX $*" >> "$MARKER"; exit 0
SH
cat > "$STUB/fab" <<'SH'
#!/bin/sh
echo 'fab version 1.6.1'
SH
ln -s "$REAL_NODE" "$STUB/node"; ln -s "$REAL_PY" "$STUB/python3"
chmod +x "$STUB/pi" "$STUB/npm" "$STUB/pipx" "$STUB/fab"
PATH="$STUB:/usr/bin:/bin"; COOP_TEST_STUB_PATH="$STUB"; export PATH COOP_TEST_STUB_PATH
: > "$MARKER"
COOP_FLEET_TEST_MODE=1 COOP_NO_ONBOARD=1 bash "$ROOT/scripts/install.sh" --force >/dev/null 2>&1
for spec in \
  'npm:pi-mcp-adapter@2.10.0' 'npm:pi-hermes-memory@0.7.17' \
  'npm:pi-better-openai@0.1.22' 'npm:pi-web-access@0.10.7' \
  'npm:@juicesharp/rpiv-ask-user-question@1.20.0' 'npm:context-mode@1.0.162'; do
  grep -F "PI install $spec" "$MARKER" >/dev/null || { echo "missing install spec $spec"; cat "$MARKER"; exit 1; }
done
grep -F 'PIPX inject ms-fabric-cli fabric-cicd==1.1.0' "$MARKER" >/dev/null
: > "$MARKER"
COOP_FLEET_TEST_MODE=1 COOP_PI_LATEST_OVERRIDE=0.80.2 COOP_PYPI_LATEST_OVERRIDE=0.1.0 bash "$ROOT/scripts/update.sh" >/dev/null 2>&1
for spec in 'npm:pi-mcp-adapter@2.10.0' 'npm:pi-hermes-memory@0.7.17' 'npm:pi-better-openai@0.1.22' 'npm:pi-web-access@0.10.7' 'npm:@juicesharp/rpiv-ask-user-question@1.20.0' 'npm:context-mode@1.0.162'; do
  grep -F "PI install $spec" "$MARKER" >/dev/null || { echo "missing update spec $spec"; exit 1; }
done
! grep -F 'PI update --extensions' "$MARKER" >/dev/null
: > "$MARKER"
COOP_RELEASE_MANIFEST="$ROOT/config/release-manifest.json" bash "$ROOT/scripts/sync.sh" >/dev/null 2>&1
for spec in 'npm:pi-mcp-adapter@2.10.0' 'npm:pi-hermes-memory@0.7.17' 'npm:pi-better-openai@0.1.22' 'npm:pi-web-access@0.10.7' 'npm:@juicesharp/rpiv-ask-user-question@1.20.0' 'npm:context-mode@1.0.162'; do
  grep -F "PI install $spec" "$MARKER" >/dev/null || { echo "missing sync spec $spec"; exit 1; }
done
if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -Command ". '$ROOT/lib/common.ps1'; if ((Coop-ManifestExtensionSpec '@juicesharp/rpiv-ask-user-question') -ne 'npm:@juicesharp/rpiv-ask-user-question@1.20.0') { exit 1 }; if ((Coop-ManifestPythonSpec 'fabric-cicd') -ne 'fabric-cicd==1.1.0') { exit 1 }"
fi
echo '  ✓ normal install/update/sync executed exact manifest specs (plus PowerShell literal helpers)'
