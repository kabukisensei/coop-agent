#!/usr/bin/env bash
#
# Slice 2: truthful inventory tests for `coop doctor` and `coop sync`.
#
# Everything runs against FIXTURES in a temp dir:
#   • a fixture release manifest      (COOP_RELEASE_MANIFEST)
#   • a fake `pipx`                   (runpip show reads fixture .meta files)
#   • fake venv trees                 (COOP_PIPX_HOME, incl. fake venv pythons)
#   • fake CLI executables            (a genuine-looking `fab` inside the fake
#                                      venv; a Paramiko-flavored `fab` outside it)
# The workstation's real pipx/venvs/executables are never probed and nothing is
# repaired — doctor stays read-only here.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
[ -z "$PY" ] && { echo "python3 required"; exit 1; }

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PIN_FAB="1.7.0"; PIN_DDD="1.2.0"

cat > "$TMP/manifest.json" <<EOF
{
  "schema_version": 1,
  "python_tools": {
    "coop-data-doc": "$PIN_DDD",
    "coop-sql-review": "0.15.2",
    "coop-dax-review": "0.22.0",
    "ms-fabric-cli": "$PIN_FAB",
    "fabric-cicd": "1.3.0"
  }
}
EOF

# Fake executables live in the FIXTURE HOME's .local/bin: lib/common.sh prepends
# exactly that directory above its own /usr/local/bin + /opt/homebrew/bin
# additions, so the fakes always beat both the workstation's real tools AND any
# leaked stubs. Nothing from the real machine is invoked.
FIXHOME="$TMP/home"; FAKEBIN="$FIXHOME/.local/bin"; mkdir -p "$FAKEBIN"
# Dedicated node dir: symlink ONLY node/npm into it, instead of pointing PATH at
# the real node directory. Co-located binaries (e.g. a real /usr/local/bin/fab
# on fab-equipped hosts) would otherwise leak into the isolated doctor PATH and
# make the F2 'missing ms-fabric-cli' scenario environment-dependent. doctor
# still resolves node/npm here for its version checks.
NODE_DIR="$TMP/nodebin"; mkdir -p "$NODE_DIR"
for _b in node npm; do
  _real="$(command -v "$_b" 2>/dev/null || true)"
  [ -n "$_real" ] && ln -s "$_real" "$NODE_DIR/$_b"
done
# Dedicated python dir: never reuse ~/.local/bin (this workstation keeps
# python3 AND the real fab/coop shims there, which would defeat isolation).
PY_DIR="$TMP/pybin"; mkdir -p "$PY_DIR"
# Use a real wrapper rather than a symlink. Git Bash on Windows may materialize
# `ln -s` as a plain text file when symlink creation is unavailable, which made
# the supposedly hermetic fixture unable to execute Python.
cat > "$PY_DIR/python3" <<EOF
#!/bin/sh
exec "$PY" "\$@"
EOF
chmod +x "$PY_DIR/python3"
BASE_PATH="$NODE_DIR:$PY_DIR:/usr/bin:/bin"
PIPXHOME="$TMP/pipxhome"; mkdir -p "$PIPXHOME/venvs/ms-fabric-cli/bin" "$PIPXHOME/venvs/coop-data-doc/bin"

# --- fake pipx: `runpip <venv> show <dist>` reads <fixture>/<venv>--<dist>.meta
cat > "$FAKEBIN/pipx" <<'EOF'
#!/bin/sh
FIX="$COOP_TEST_PIPX_FIXTURE"
[ -n "$FIX" ] || exit 1
if [ "$1" = "runpip" ] && [ "$3" = "show" ]; then
  f="$FIX/$2--$4.meta"
  [ -f "$f" ] && { cat "$f"; exit 0; }
  exit 1
fi
exit 1
EOF
chmod +x "$FAKEBIN/pipx"

put_meta() { # <venv> <dist> <version-or-empty>
  local f="$TMP/fixtures/$1--$2.meta"
  if [ -n "$3" ]; then printf 'Name: %s\nVersion: %s\n' "$2" "$3" > "$f"; else rm -f "$f"; fi
}
mkdir -p "$TMP/fixtures"

# --- fake venv python (fixture): bakes version + Requires-Python answers ------
venv_python() { # <venv> <version> [requires-python]
  local rp="${3:-}"
  {
    echo "FAKEPY_VERSION='$2'"
    echo "FAKEPY_RP='$rp'"
    cat "$ROOT/tests/fixtures/venv-python.sh"
  } > "$PIPXHOME/venvs/$1/bin/python"
  chmod +x "$PIPXHOME/venvs/$1/bin/python"
}


# --- genuine-looking fab: lives INSIDE the fake ms-fabric-cli venv ------------
make_real_fab() { # <version>
  mkdir -p "$PIPXHOME/venvs/ms-fabric-cli/bin"
  cat > "$PIPXHOME/venvs/ms-fabric-cli/bin/fab" <<EOF
#!/bin/sh
[ "\$1" = "--version" ] && { echo "$1"; exit 0; }
exit 1
EOF
  chmod +x "$PIPXHOME/venvs/ms-fabric-cli/bin/fab"
}
remove_fab() { rm -f "$PIPXHOME/venvs/ms-fabric-cli/bin/fab"; }

# Genuine-looking coop-data-doc: lives INSIDE its fake pipx venv so ownership
# probes pass exactly as they would for a pipx-installed console script.
make_real_cdd() { # <version>
  mkdir -p "$PIPXHOME/venvs/coop-data-doc/bin"
  {
    echo '#!/bin/sh'
    echo "echo coop-data-doc, version $1"
  } > "$PIPXHOME/venvs/coop-data-doc/bin/coop-data-doc"
  chmod +x "$PIPXHOME/venvs/coop-data-doc/bin/coop-data-doc"
}


doctor_out() { # <scratch-cwd> [path-prefix]
  local pfx="${2:-}"
  local fixture_bins="$PIPXHOME/venvs/ms-fabric-cli/bin:$PIPXHOME/venvs/coop-data-doc/bin:$FAKEBIN"
  ( cd "$1" && COOP_ROOT="$ROOT" \
      HOME="$FIXHOME" PATH="$pfx$fixture_bins:$BASE_PATH" \
      COOP_RELEASE_MANIFEST="$TMP/manifest.json" \
      COOP_TEST_PIPX_FIXTURE="$TMP/fixtures" \
      COOP_PIPX_HOME="$PIPXHOME" COOP_PIPX_BIN="$FAKEBIN/pipx" \
      PI_CODING_AGENT_DIR="$TMP/noagent" COOP_TEST_STUB_PATH="$pfx$fixture_bins" \
      bash "$ROOT/scripts/doctor.sh" 2>&1 </dev/null )
}

d="$TMP/run"; mkdir -p "$d"

echo "→ doctor: ms-fabric-cli checked as a distribution whose executable is fab"

# F1: exact match — metadata, CLI, and membership all agree.
put_meta ms-fabric-cli ms-fabric-cli "$PIN_FAB"
make_real_fab "$PIN_FAB"
venv_python ms-fabric-cli 3.13.1 "<3.14,>=3.10"
out="$(doctor_out "$d")"
case "$out" in
  *"ms-fabric-cli $PIN_FAB matches manifest"*) ok "exact match reported against the fab executable" ;;
  *) ko "exact match not recognized: $(printf '%s' "$out" | grep -A1 'Fabric CLI' | tail -2)" ;;
esac
case "$out" in
  *"ms-fabric-cli not installed"*) ko "false 'ms-fabric-cli not installed' warning persists" ;;
  *) ok "no false 'not installed' warning when only fab exists" ;;
esac

# F2: missing package — no venv metadata and no fab anywhere.
remove_fab; put_meta ms-fabric-cli ms-fabric-cli ""
out="$(doctor_out "$d")"
case "$out" in
  *"ms-fabric-cli not installed"*) ok "missing distribution reported" ;;
  *) ko "missing ms-fabric-cli not reported" ;;
esac

# F3: wrong version — metadata and CLI agree with each other, differ from pin.
put_meta ms-fabric-cli ms-fabric-cli "1.6.1"
make_real_fab "1.6.1"
venv_python ms-fabric-cli 3.13.1 "<3.14,>=3.10"
out="$(doctor_out "$d")"
case "$out" in
  *"ms-fabric-cli 1.6.1"*"older than manifest"*) ok "older version reported with manifest reference" ;;
  *) ko "wrong version not classified: $(printf '%s' "$out" | grep 'ms-fabric-cli' | head -2)" ;;
esac

# F4: stale/corrupt environment — in-venv metadata disagrees with the CLI.
#     Mirrors the workstation shape: metadata 1.2.0 vs CLI-reported 1.0.0.
put_meta coop-data-doc coop-data-doc "$PIN_DDD"
make_real_cdd "1.0.0"
out="$(doctor_out "$d")"
case "$out" in
  *stale*"coop-data-doc"*|*"coop-data-doc"*stale*) ok "metadata/CLI disagreement classified as stale environment" ;;
  *) ko "stale coop-data-doc environment not flagged: $(printf '%s' "$out" | grep 'coop-data-doc' | head -3)" ;;
esac
case "$out" in
  *"pipx install --force coop-data-doc==$PIN_DDD"*) ok "repair command names the exact pinned reinstall" ;;
  *) ko "repair command missing/inexact: $(printf '%s' "$out" | grep -i 'force.*coop-data-doc' | head -1)" ;;
esac

# F4b: pipx itself broken/shadowed -> classify by CLI, flag unreadable metadata.
rm -f "$TMP/fixtures/coop-data-doc--coop-data-doc.meta"
out="$(doctor_out "$d")"
if printf '%s' "$out" | grep -qF 'coop-data-doc 1.0.0 differs from manifest per coop-data-doc (pipx metadata unreadable)'; then
  ok "unreadable pipx metadata reported alongside the CLI classification"
else
  ko "metadata-unavailable fallback not handled: $(printf '%s' "$out" | grep 'coop-data-doc' | head -2)"
fi
put_meta coop-data-doc coop-data-doc "$PIN_DDD"

# F5: wrong fab — a Paramiko/Fabric SSH tool must still be rejected, and must
#     not be counted as ms-fabric-cli even if a venv exists.
put_meta ms-fabric-cli ms-fabric-cli "$PIN_FAB"
remove_fab
mkdir -p "$FAKEBIN/wrongfab"
cat > "$FAKEBIN/wrongfab/fab" <<'EOF'
#!/bin/sh
[ "$1" = "--version" ] && { echo "Fabric 2.7.4 (paramiko)"; exit 0; }
exit 1
EOF
chmod +x "$FAKEBIN/wrongfab/fab"
out="$(doctor_out "$d" "$FAKEBIN/wrongfab:")"
case "$out" in
  *"WRONG"*) ok "Paramiko fab still rejected as the wrong tool" ;;
  *) ko "paramiko fab not rejected" ;;
esac
case "$out" in
  *"ms-fabric-cli $PIN_FAB matches manifest"*) ko "paramiko fab was accepted as ms-fabric-cli" ;;
  *) ok "paramiko fab not accepted as ms-fabric-cli" ;;
esac

if [ "$fail" -eq 0 ]; then
  echo "all inventory tests passed"
else
  echo "inventory tests FAILED"
fi
exit "$fail"
