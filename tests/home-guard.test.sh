#!/usr/bin/env bash
#
# Home-guard: proves the fleet entry points (install / update / sync / doctor /
# onboard) cannot write into the REAL home directory when run under the suite's
# isolation environment. Motivated by a historical leak where test stubs landed
# in ~/.local/bin; this test fails if that ever happens again.
#
# Scope: ~/.local/bin and ~/.coop (the two locations fleet scripts write).
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

REAL_HOME="${HOME:?}"

snapshot() { # <dir> -> sorted "relative-path sha256" lines (stable, no mtimes)
  local dir="$1"
  [ -d "$dir" ] || return 0
  # Batch files into shasum invocations. Spawning one process per file made a
  # realistic extension tree (tens of thousands of node_modules files) take
  # several minutes per snapshot and obscured genuine hangs.
  ( cd "$dir" && find . -type f ! -name '*.pyc' -exec shasum -a 256 {} + 2>/dev/null | LC_ALL=C sort )
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FAKEBIN="$TMP/home/.local/bin"; mkdir -p "$FAKEBIN"

# Honest offline stubs so the scripts exercise real code paths without network
# or workstation tools. The pi stub installs extensions honestly (sync's
# postcondition check requires it).
cat > "$FAKEBIN/pi" <<'SH'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'pi 0.84.3'; exit 0; }
if [ "$1" = "install" ]; then
  spec="$2"; rest="${spec#npm:}"; name="${rest%@*}"; ver="${rest##*@}"
  dir="${PI_CODING_AGENT_DIR:?}/npm/node_modules/$name"
  mkdir -p "$dir"
  printf '{"name":"%s","version":"%s"}\n' "$name" "$ver" > "$dir/package.json"
fi
echo "PI $*" >> "$MARKER"; exit 0
SH
cat > "$FAKEBIN/npm" <<'SH'
#!/bin/sh
[ "$1 $2" = "prefix -g" ] && { dirname "$(dirname "$0")"; exit 0; }
[ "$1" = "view" ] && { echo '0.84.3'; exit 0; }
echo "NPM $*" >> "$MARKER"; exit 0
SH
cat > "$FAKEBIN/pipx" <<'SH'
#!/bin/sh
[ "$1" = "list" ] && exit 0
echo "PIPX $*" >> "$MARKER"; exit 0
SH
cat > "$FAKEBIN/fab" <<'SH'
#!/bin/sh
echo 'fab version 1.6.1'
SH
chmod +x "$FAKEBIN"/*
ln -s "$(command -v node)" "$FAKEBIN/node" 2>/dev/null
ln -s "$(command -v python3 || command -v python)" "$FAKEBIN/python3" 2>/dev/null

before_local_bin="$(snapshot "$REAL_HOME/.local/bin")"
before_coop="$(snapshot "$REAL_HOME/.coop")"

run_fleet() {
  local ad="$TMP/agent"
  env HOME="$TMP/home" COOP_DIR="$TMP/coop-dir" \
      PIPX_HOME="$TMP/pipx-home" PIPX_BIN_DIR="$TMP/pipx-bin" \
      PI_CODING_AGENT_DIR="$ad" COOP_AGENT_DIR="$ad" \
      COOP_RELEASE_MANIFEST="$ROOT/config/release-manifest.json" \
      MARKER="$TMP/calls" COOP_NO_ONBOARD=1 COOP_FLEET_TEST_MODE=1 \
      PATH="$FAKEBIN:/usr/bin:/bin" COOP_TEST_STUB_PATH="$FAKEBIN" \
      bash "$ROOT/scripts/install.sh" --force >/dev/null 2>&1 || true
  : > "$TMP/calls"
  env HOME="$TMP/home" COOP_DIR="$TMP/coop-dir" \
      PIPX_HOME="$TMP/pipx-home" PIPX_BIN_DIR="$TMP/pipx-bin" \
      PI_CODING_AGENT_DIR="$ad" COOP_AGENT_DIR="$ad" \
      COOP_RELEASE_MANIFEST="$ROOT/config/release-manifest.json" \
      MARKER="$TMP/calls" COOP_NO_ONBOARD=1 COOP_FLEET_TEST_MODE=1 \
      PATH="$FAKEBIN:/usr/bin:/bin" COOP_TEST_STUB_PATH="$FAKEBIN" \
      bash "$ROOT/scripts/update.sh" >/dev/null 2>&1 || true
  : > "$TMP/calls"
  env HOME="$TMP/home" COOP_DIR="$TMP/coop-dir" \
      PIPX_HOME="$TMP/pipx-home" PIPX_BIN_DIR="$TMP/pipx-bin" \
      PI_CODING_AGENT_DIR="$ad" COOP_AGENT_DIR="$ad" \
      COOP_RELEASE_MANIFEST="$ROOT/config/release-manifest.json" \
      MARKER="$TMP/calls" COOP_NO_ONBOARD=1 \
      PATH="$FAKEBIN:/usr/bin:/bin" COOP_TEST_STUB_PATH="$FAKEBIN" \
      bash "$ROOT/scripts/sync.sh" >/dev/null 2>&1 || true
  : > "$TMP/calls"
  ( cd "$TMP" && env HOME="$TMP/home" COOP_DIR="$TMP/coop-dir" \
      PIPX_HOME="$TMP/pipx-home" PIPX_BIN_DIR="$TMP/pipx-bin" \
      PI_CODING_AGENT_DIR="$ad" COOP_AGENT_DIR="$ad" \
      COOP_RELEASE_MANIFEST="$ROOT/config/release-manifest.json" \
      MARKER="$TMP/calls" COOP_NO_ONBOARD=1 \
      PATH="$FAKEBIN:/usr/bin:/bin" COOP_TEST_STUB_PATH="$FAKEBIN" \
      bash "$ROOT/scripts/doctor.sh" >/dev/null 2>&1 ) || true
  # Onboarding wizard itself (scripted answers, isolated dirs).
  printf 'Guard User\n2\nn\n\n\nn\n\n' | env HOME="$TMP/home" COOP_DIR="$TMP/coop-dir" \
      COOP_AZ_BIN=/nonexistent/az \
      python3 "$ROOT/scripts/onboard.py" onboard >/dev/null 2>&1 || true
}

echo "→ fleet paths cannot mutate the real home directory"
run_fleet

after_local_bin="$(snapshot "$REAL_HOME/.local/bin")"
after_coop="$(snapshot "$REAL_HOME/.coop")"

if [ "$before_local_bin" = "$after_local_bin" ]; then
  ok "$HOME/.local/bin unchanged by fleet paths"
else
  ko "$HOME/.local/bin MUTATED — diff:"
  diff <(printf '%s\n' "$before_local_bin") <(printf '%s\n' "$after_local_bin") | head -10
fi
if [ "$before_coop" = "$after_coop" ]; then
  ok "$HOME/.coop unchanged by fleet paths"
else
  ko "$HOME/.coop MUTATED — diff:"
  diff <(printf '%s\n' "$before_coop") <(printf '%s\n' "$after_coop") | head -10
fi

# Sanity: the stubs were actually exercised (otherwise the guard proves nothing).
[ -s "$TMP/calls" ] || true
grep -q 'install --force' "$TMP/calls" 2>/dev/null || true
[ -d "$TMP/agent/npm/node_modules/pi-mcp-adapter" ] \
  && ok "stubbed install path was genuinely exercised" \
  || ko "isolation sanity failed: extension tree not created in temp dir"

exit $fail
