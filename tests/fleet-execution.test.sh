#!/usr/bin/env bash
# Execute normal install/update/sync fleet paths with offline stubs and assert exact specs.
set -euo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
ORIG_HOME="$HOME"
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

# --- NORMAL-mode drift convergence (no --force): round-2 review item #1 ---------
# Deliberate drift: installed Pi 0.81.0 (manifest says 0.80.2) and
# coop-data-doc 1.1.0 (manifest says 1.1.1); ms-fabric-cli matches its pin.
D2="$(mktemp -d)"; HOME="$D2/home"; STUB2="$HOME/.local/bin"; MARKER2="$D2/calls"; mkdir -p "$STUB2"; export HOME MARKER2
cat > "$STUB2/pi" <<'SH'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'pi 0.81.0'; exit 0; }
echo "PI $*" >> "$MARKER2"; exit 0
SH
cat > "$STUB2/npm" <<'SH'
#!/bin/sh
[ "$1 $2" = "prefix -g" ] && { dirname "$(dirname "$0")"; exit 0; }
echo "NPM $*" >> "$MARKER2"; exit 0
SH
cat > "$STUB2/pipx" <<'SH'
#!/bin/sh
if [ "$1" = "list" ]; then
  echo 'package coop-data-doc 1.1.0'; echo 'package coop-sql-review 0.15.2'; echo 'package coop-dax-review 0.22.0'; echo 'package ms-fabric-cli 1.6.1'; exit 0
fi
echo "PIPX $*" >> "$MARKER2"; exit 0
SH
cat > "$STUB2/fab" <<'SH'
#!/bin/sh
echo 'fab version 1.6.1'
SH
ln -s "$REAL_NODE" "$STUB2/node"; ln -s "$REAL_PY" "$STUB2/python3"
chmod +x "$STUB2/pi" "$STUB2/npm" "$STUB2/pipx" "$STUB2/fab"
PATH="$STUB2:/usr/bin:/bin"; COOP_TEST_STUB_PATH="$STUB2"; export PATH COOP_TEST_STUB_PATH
: > "$MARKER2"
COOP_FLEET_TEST_MODE=1 COOP_NO_ONBOARD=1 bash "$ROOT/scripts/install.sh" >/dev/null 2>&1
grep -F 'NPM install -g @earendil-works/pi-coding-agent@0.80.2' "$MARKER2" >/dev/null \
  || { echo 'drifted Pi NOT converged to manifest'; grep '^NPM install' "$MARKER2"; exit 1; }
grep -F 'PIPX install --force coop-data-doc==1.1.1' "$MARKER2" >/dev/null \
  || { echo 'drifted coop-data-doc NOT force-installed to pin'; exit 1; }
! grep -F 'PIPX install --force ms-fabric-cli==' "$MARKER2" >/dev/null \
  || { echo 'matching fabric-cli was reinstalled despite matching pin'; exit 1; }
echo '  ✓ normal install converges drifted Pi and pipx tools without --force'

# --- NORMAL-mode skip when everything already matches ----------------------------
D3="$(mktemp -d)"; HOME="$D3/home"; STUB3="$HOME/.local/bin"; MARKER3="$D3/calls"; mkdir -p "$STUB3"; export HOME MARKER3
cat > "$STUB3/pi" <<'SH'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'pi 0.80.2'; exit 0; }
echo "PI $*" >> "$MARKER3"; exit 0
SH
cp "$STUB/npm" "$STUB3/npm"; cp "$STUB/fab" "$STUB3/fab"; cat > "$STUB3/pipx" <<'SH'
#!/bin/sh
if [ "$1" = "list" ]; then
  echo 'package coop-data-doc 1.1.1'; echo 'package ms-fabric-cli 1.6.1'; exit 0
fi
echo "PIPX $*" >> "$MARKER3"; exit 0
SH
ln -s "$REAL_NODE" "$STUB3/node"; ln -s "$REAL_PY" "$STUB3/python3"
chmod +x "$STUB3/pi" "$STUB3/npm" "$STUB3/pipx" "$STUB3/fab"
PATH="$STUB3:/usr/bin:/bin"; COOP_TEST_STUB_PATH="$STUB3"; export PATH COOP_TEST_STUB_PATH
: > "$MARKER3"
COOP_FLEET_TEST_MODE=1 COOP_NO_ONBOARD=1 bash "$ROOT/scripts/install.sh" >/dev/null 2>&1
! grep -qE '^NPM install -g @earendil-works/pi-coding-agent@' "$MARKER3" \
  || { echo 'Pi was reinstalled although it matched the manifest'; exit 1; }
! grep -F 'PIPX install --force coop-data-doc==' "$MARKER3" >/dev/null \
  || { echo 'coop-data-doc was reinstalled although it matched the manifest'; exit 1; }
echo '  ✓ normal install skips components already at their manifest pins'

restore_home() { HOME="$ORIG_HOME"; }

echo '  ✓ normal install/update/sync executed exact manifest specs (plus PowerShell literal helpers)'
