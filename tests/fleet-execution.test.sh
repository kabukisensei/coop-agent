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

# --- --edge on an EXISTING machine attempts upstream latest ----------------------
# Existing Pi 0.80.2 + coop-data-doc 1.1.1: edge must attempt an upgrade, not skip.
D4="$(mktemp -d)"; HOME="$D4/home"; STUB4="$HOME/.local/bin"; MARKER4="$D4/calls"; mkdir -p "$STUB4"; export HOME MARKER4
cat > "$STUB4/pi" <<'SH'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'pi 0.80.2'; exit 0; }
echo "PI $*" >> "$MARKER4"; exit 0
SH
cat > "$STUB4/npm" <<'SH'
#!/bin/sh
[ "$1 $2" = "prefix -g" ] && { dirname "$(dirname "$0")"; exit 0; }
echo "NPM $*" >> "$MARKER4"; exit 0
SH
cat > "$STUB4/pipx" <<'SH'
#!/bin/sh
if [ "$1" = "list" ]; then echo 'package coop-data-doc 1.1.1'; echo 'package ms-fabric-cli 1.6.1'; exit 0; fi
echo "PIPX $*" >> "$MARKER4"; exit 0
SH
cat > "$STUB4/fab" <<'SH'
#!/bin/sh
echo 'fab version 1.6.1'
SH
ln -s "$REAL_NODE" "$STUB4/node"; ln -s "$REAL_PY" "$STUB4/python3"
chmod +x "$STUB4/pi" "$STUB4/npm" "$STUB4/pipx" "$STUB4/fab"
PATH="$STUB4:/usr/bin:/bin"; COOP_TEST_STUB_PATH="$STUB4"; export PATH COOP_TEST_STUB_PATH
: > "$MARKER4"
COOP_FLEET_TEST_MODE=1 COOP_NO_ONBOARD=1 bash "$ROOT/scripts/install.sh" --edge >/dev/null 2>&1
grep -F 'NPM install -g @earendil-works/pi-coding-agent' "$MARKER4" >/dev/null \
  || { echo 'edge install did not attempt a Pi upstream update'; exit 1; }
grep -F 'PIPX upgrade coop-data-doc' "$MARKER4" >/dev/null \
  || { echo 'edge install did not attempt a pipx upgrade for an existing tool'; exit 1; }
echo '  ✓ install --edge attempts upstream latest for existing installs'

# --- Fabric failed convergence must NOT read as success --------------------------
# pipx refuses the --force install of ms-fabric-cli==pin while an OLD fab binary
# stays on PATH: the unit must fail, not report "ready".
D5="$(mktemp -d)"; HOME="$D5/home"; STUB5="$HOME/.local/bin"; MARKER5="$D5/calls"; mkdir -p "$STUB5"; export HOME MARKER5
cat > "$STUB5/pi" <<'SH'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'pi 0.80.2'; exit 0; }
echo "PI $*" >> "$MARKER5"; exit 0
SH
cat > "$STUB5/npm" <<'SH'
#!/bin/sh
[ "$1 $2" = "prefix -g" ] && { dirname "$(dirname "$0")"; exit 0; }
echo "NPM $*" >> "$MARKER5"; exit 0
SH
cat > "$STUB5/pipx" <<'SH'
#!/bin/sh
if [ "$1" = "list" ]; then echo 'package coop-data-doc 1.1.1'; echo 'package ms-fabric-cli 1.5.0'; exit 0; fi
if [ "$1" = "install" ] && [ "$3" = "ms-fabric-cli==1.6.1" ]; then exit 1; fi
echo "PIPX $*" >> "$MARKER5"; exit 0
SH
cat > "$STUB5/fab" <<'SH'
#!/bin/sh
echo 'fab version 1.5.0'
SH
ln -s "$REAL_NODE" "$STUB5/node"; ln -s "$REAL_PY" "$STUB5/python3"
chmod +x "$STUB5/pi" "$STUB5/npm" "$STUB5/pipx" "$STUB5/fab"
PATH="$STUB5:/usr/bin:/bin"; COOP_TEST_STUB_PATH="$STUB5"; export PATH COOP_TEST_STUB_PATH
: > "$MARKER5"
COOP_FLEET_TEST_MODE=1 COOP_NO_ONBOARD=1 bash "$ROOT/scripts/install.sh" >/dev/null 2>&1
! grep -F 'PIPX inject ms-fabric-cli' "$MARKER5" >/dev/null \
  || { echo 'fabric inject ran despite failed convergence'; exit 1; }
out5="$(PATH="$STUB5:/usr/bin:/bin" COOP_TEST_STUB_PATH="$STUB5" COOP_FLEET_TEST_MODE=1 COOP_NO_ONBOARD=1 bash "$ROOT/scripts/install.sh" 2>&1)"
case "$out5" in
  *"failed to converge ms-fabric-cli"*|*"remains at"*) : ;;
  *"Microsoft Fabric CLI ready"*) echo 'fabric reported ready after FAILED convergence'; exit 1 ;;
  *) echo "unexpected fabric outcome: no converge-failure message"; exit 1 ;;
esac
echo '  ✓ failed Fabric convergence is reported as failure, not ready'


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
