#!/usr/bin/env bash
#
# Home-guard: proves the fleet entry points (install / update / sync / doctor /
# onboard) cannot write into the REAL home directory when run under the suite's
# isolation environment. Motivated by a historical leak where test stubs landed
# in ~/.local/bin; this test fails if that ever happens again.
#
# Scope: ~/.local/bin and ~/.coop (the two locations fleet scripts write), plus
# the checkout running the tests, which update and doctor must never fetch or move.
set -uo pipefail

CHECKOUT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
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
# Run the fleet scripts from a plain copy of this tree with no .git (#104): step 1
# of `coop update` and doctor fetch from origin (update also fast-forwards) in the
# checkout they run from, and a test must never touch the checkout running it.
# Dot entries other than the bundled .coop contract are git, CI and cache files.
ROOT="$TMP/coop-agent"; mkdir "$ROOT"
cp -R "$CHECKOUT"/* "$CHECKOUT/.coop" "$ROOT/"
FAKEBIN="$TMP/home/.local/bin"; mkdir -p "$FAKEBIN"

# Honest offline stubs so the scripts exercise real code paths without network
# or workstation tools. The pi stub installs extensions honestly (sync's
# postcondition check requires it).
cat > "$FAKEBIN/pi" <<'SH'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'pi 0.87.1'; exit 0; }
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
[ "$1" = "view" ] && { echo '0.87.1'; exit 0; }
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
# A Fabric-compatible (3.10-3.13) Python and an Azure CLI stub let install pass
# its H1 prerequisite gate, so the install path below really runs.
ln -s "$(command -v python3.13 || command -v python3.12 || command -v python3 || command -v python)" "$FAKEBIN/python3" 2>/dev/null
printf '#!/bin/sh\necho azure-cli 2.80.0\n' > "$FAKEBIN/az"; chmod +x "$FAKEBIN/az"
# Real git behind a wrapper (Git Bash keeps git in /mingw64/bin, off this PATH).
printf '#!/bin/sh\nexec "%s" "$@"\n' "$(command -v git)" > "$FAKEBIN/git"; chmod +x "$FAKEBIN/git"

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
      bash "$ROOT/scripts/update.sh" >"$TMP/update.out" 2>&1 || true
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
      bash "$ROOT/scripts/doctor.sh" >"$TMP/doctor.out" 2>&1 ) || true
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

# Update and doctor ran from the copy, so neither saw a git checkout to fetch or move.
if grep -F 'not a git checkout' "$TMP/update.out" >/dev/null \
   && grep -F 'not a git checkout' "$TMP/doctor.out" >/dev/null; then
  ok "update and doctor ran from a copy, never the checkout running the tests"
else
  ko "update or doctor ran against a git checkout; fleet paths must run from a copy (#104)"
fi

# Sanity: the stubs were actually exercised (otherwise the guard proves nothing).
[ -s "$TMP/calls" ] || true
grep -q 'install --force' "$TMP/calls" 2>/dev/null || true
[ -d "$TMP/agent/npm/node_modules/pi-mcp-adapter" ] \
  && ok "stubbed install path was genuinely exercised" \
  || ko "isolation sanity failed: extension tree not created in temp dir"

exit $fail
