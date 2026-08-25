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

PIN_FAB="1.7.0"; PIN_DDD="1.1.1"

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
# Dedicated python dir: never reuse ~/.local/bin (this workstation keeps
# python3 AND the real fab/coop shims there, which would defeat isolation).
NODE_DIR="$(dirname "$(command -v node)")"
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
#     Mirrors the workstation shape: metadata 1.1.1 vs CLI-reported 1.0.0.
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
  *) ok "paramiko fab not credited as ms-fabric-cli" ;;
esac
rm -rf "$FAKEBIN/wrongfab"

# F6: violating venv Python — the distribution's own installed Requires-Python
# ("<3.14,>=3.10") rejects the venv's 3.14.x.
make_real_fab "$PIN_FAB"
venv_python ms-fabric-cli 3.14.5 "<3.14,>=3.10"
out="$(doctor_out "$d")"
case "$out" in
  *"3.14"*) ok "venv Python 3.14 reported for ms-fabric-cli" ;;
  *) ko "venv interpreter version not reported" ;;
esac
case "$out" in
  *"violates its own requires-python '<3.14,>=3.10'"*)
    ok "3.14 venv flagged against installed Requires-Python metadata" ;;
  *) ko "Requires-Python violation not flagged: $(printf '%s' "$out" | grep 'ms-fabric-cli env' | head -1)" ;;
esac
case "$out" in
  *"--python 3.12"*|*"--python 3.13"*) ok "repair suggests recreating with a supported Python" ;;
  *) ko "repair does not suggest a supported --python" ;;
esac

# F7: supported venv Python passes quietly, citing the metadata.
venv_python ms-fabric-cli 3.12.7 "<3.14,>=3.10"
out="$(doctor_out "$d")"
case "$out" in
  *"violates"*) ko "supported venv Python falsely flagged: $(printf '%s' "$out" | grep violates | head -2)" ;;
  *) ok "Python 3.12 venv accepted without a violation warning" ;;
esac
case "$out" in
  *"ms-fabric-cli environment uses Python 3.12.7 (requires-python: <3.14,>=3.10)"*)
    ok "interpreter reported with its Requires-Python metadata" ;;
  *) ko "interpreter+metadata line absent" ;;
esac

# F7b: NO hardcoded <3.14 — a distribution whose own metadata allows 3.14 passes.
venv_python coop-data-doc 3.14.0 ">=3.9"
put_meta coop-data-doc coop-data-doc "1.1.1"
make_real_cdd "1.1.1"
out="$(doctor_out "$d")"
case "$out" in
  *"coop-data-doc environment uses Python 3.14.0 (requires-python: >=3.9)"*)
    ok "3.14 venv accepted where the distribution's own metadata allows it" ;;
  *) ko "uncapped distribution falsely restricted to <3.14: $(printf '%s' "$out" | grep 'coop-data-doc env' | head -1)" ;;
esac

echo "→ sync: extension postconditions verified after installation"

# Direct unit coverage of the verifier over fixture agent dirs.
verify_fixture() { # <layout: ok|wrong|missing> -> prints installed version
  local layout="$1"
  local ad="$TMP/tree-$layout/npm/node_modules/pi-mcp-adapter"
  mkdir -p "$ad"
  case "$layout" in
    ok)     printf '{"name":"pi-mcp-adapter","version":"2.10.0"}' > "$ad/package.json" ;;
    wrong)  printf '{"name":"pi-mcp-adapter","version":"2.9.0"}'  > "$ad/package.json" ;;
    missing) ;;
  esac
  COOP_ROOT="$ROOT" bash -c '. "'"$ROOT"'/lib/common.sh"; coop_ext_installed_version "$1" "pi-mcp-adapter"' sh "$TMP/tree-$layout"
}
[ "$(verify_fixture ok)"     = "2.10.0" ] && ok "verifier reads exact installed version" || ko "verifier failed on exact fixture"
[ -z "$(verify_fixture missing)" ] && ok "verifier returns empty for missing extension" || ko "verifier invented a version for a missing extension"

sync_run() { # <behave-file> [extra-path-prefix] -> stdout, rc
  local behave="$1"; local pfx="${2:-}"
  cat "$ROOT/tests/fixtures/sync-fake-pi.sh" > "$FAKEBIN/pi"
  chmod +x "$FAKEBIN/pi"
  local ad="$TMP/sync-agent"
  rm -rf "$ad"
  ( COOP_ROOT="$ROOT" COOP_AGENT_DIR="$ad" \
      COOP_TEST_PIPX_FIXTURE="$TMP/fixtures" COOP_PIPX_HOME="$PIPXHOME" \
      COOP_PIPX_BIN="$FAKEBIN/pipx" COOP_TEST_FAKE_PI_BEHAVIOR="$behave" \
      env HOME="$FIXHOME" COOP_TEST_STUB_PATH="$pfx$FAKEBIN" PATH="$pfx$FAKEBIN:$BASE_PATH" \
      bash "$ROOT/scripts/sync.sh" 2>&1 </dev/null )
  return $?
}

# S1: fake pi reports SUCCESS but installs a WRONG version. Production
# convergence (coop_converge_extension_pins) REPAIRS this when npm can run;
# with the package.json made read-only the enforcement cannot, and sync must
# report accurately and exit non-zero instead of claiming success.
cat > "$TMP/behave-wrong.txt" <<'EOF'
COOP_TEST_FAKE_PI_INSTALL_VERSION="0.0.1"
COOP_TEST_FAKE_PI_WRONG="context-mode"
EOF
if [ "${COOP_TEST_NETWORK:-0}" = "1" ]; then
  out="$(sync_run "$TMP/behave-wrong.txt")"; rc=$?
  [ "$rc" -eq 0 ] && ok "[network] production convergence repaired the drifted install" \
    || ko "[network] sync failed despite working enforcement (rc=$rc)"
else
  mkdir -p "$TMP/badnpm"
  printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo 10.0.0; exit 0; }\nexit 1\n' > "$TMP/badnpm/npm"
  chmod +x "$TMP/badnpm/npm"
  out="$(sync_run "$TMP/behave-wrong.txt" "$TMP/badnpm:")"; rc=$?
  [ "$rc" -ne 0 ] && ok "blocked enforcement + drifted install -> nonzero result" \
    || ko "sync exited 0 despite blocked enforcement"
  case "$out" in
    *"context-mode"*) ok "failure names the offending extension" ;;
    *) ko "failure output omits context-mode" ;;
  esac
  case "$out" in
    *"context-mode pinned (isolated)"*) ko "claimed 'pinned' despite failed postcondition" ;;
    *) ok "does not claim 'pinned' when the postcondition failed" ;;
  esac
fi

# S2: fake pi succeeds but installs NOTHING.
printf 'COOP_TEST_FAKE_PI_SKIP="context-mode"\n' > "$TMP/behave-skip.txt"
chmod 755 "$TMP/sync-agent/npm/package.json" 2>/dev/null || true
if [ "${COOP_TEST_NETWORK:-0}" = "1" ]; then
  out="$(sync_run "$TMP/behave-skip.txt")"; rc=$?
  [ "$rc" -eq 0 ] && ok "[network] missing extension restored by production convergence" \
    || ko "[network] sync exited $rc despite working enforcement"
else
  out="$(sync_run "$TMP/behave-skip.txt" "$TMP/badnpm:")"; rc=$?
  [ "$rc" -ne 0 ] && ok "missing-after-successful-install (enforcement blocked) -> nonzero result" \
    || ko "sync exited 0 despite missing extension"
fi

# S3: honest success path — correct install converges and reports precisely.
printf 'COOP_TEST_FAKE_PI_OK=1\n' > "$TMP/behave-ok.txt"
out="$(sync_run "$TMP/behave-ok.txt")"; rc=$?
[ "$rc" -eq 0 ] && ok "correct convergence exits zero" || ko "honest sync failed (rc=$rc): $(printf '%s' "$out" | tail -5)"
case "$out" in
  *"Ensuring isolated pi-mcp-adapter is version"*) ok "convergence message states the exact target version" ;;
  *) ko "targeted convergence message missing" ;;
esac
case "$out" in
  *"Already at release version"*|*"Installed release version"*) ok "postcondition outcome stated precisely" ;;
  *) ko "precise outcome message missing" ;;
esac
case "$out" in
  *"Your personal Pi extensions are unchanged"*) ok "one-time explanation distinguishes isolated tree" ;;
  *) ko "isolated-tree explanation missing" ;;
esac

# --- S4: alignment rc 10 / rc 11 must increment failures (deterministic) -------
# Runs PRODUCTION sync.sh from a sandbox COOP_ROOT whose lib/_extdeps.py is a
# stub emitting a chosen result code/line - zero environment sensitivity.
run_sync_with_extdeps_rc() { # <rc> <line-fields...>
  local rc="$1"; shift
  local line="$*"
  local sandbox="$TMP/fakeroot-$rc"
  rm -rf "$sandbox"
  mkdir -p "$sandbox/lib" "$sandbox/config" "$sandbox/scripts" "$sandbox/bin" "$sandbox/home"
  cp "$ROOT/lib/common.sh" "$sandbox/lib/"
  cp "$ROOT/lib/pins.js" "$sandbox/lib/" 2>/dev/null || true
  cp "$ROOT/config/release-manifest.json" "$sandbox/config/"
  cp "$ROOT/scripts/sync.sh" "$sandbox/scripts/"
  # Stubbed alignment checker: emits fixed fields and exits with $rc.
  cat > "$sandbox/lib/_extdeps.py" <<PYEOF
import os, sys
print("$line")
sys.exit(int(os.environ.get("COOP_FAKE_EXTDEPS_RC", "$rc")))
PYEOF
  # Controlled tools: honest fake pi (installs at spec), sabotaged npm, real
  # node/python3 symlinks - so results are deterministic and offline.
  cat "$ROOT/tests/fixtures/sync-fake-pi.sh" > "$sandbox/bin/pi"
  printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo 22.0.0; exit 0; }\nexit 1\n' > "$sandbox/bin/npm"
  chmod +x "$sandbox/bin"/*
  local ad="$sandbox/agent"
  mkdir -p "$ad/npm/node_modules/pi-mcp-adapter" "$ad/npm"
  printf '{"name":"pi-mcp-adapter","version":"2.10.0"}\n' > "$ad/npm/node_modules/pi-mcp-adapter/package.json"
  printf '{\n  "name": "pi-extensions",\n  "private": true,\n  "dependencies": {}\n}\n' > "$ad/npm/package.json"
  HOME="$sandbox/home" COOP_AGENT_DIR="$ad" PI_CODING_AGENT_DIR="$ad" \
      COOP_RELEASE_MANIFEST="$sandbox/config/release-manifest.json" \
      COOP_FAKE_EXTDEPS_RC="$rc" COOP_PIPX_BIN=/nonexistent/pipx \
      COOP_TEST_STUB_PATH="$sandbox/bin:$BASE_PATH" PATH="$sandbox/bin:$BASE_PATH" \
      bash "$sandbox/scripts/sync.sh" >"$sandbox/sync.log" 2>&1 </dev/null
  local sync_rc=$?
  sed 's/\x1b\[[0-9;]*m//g' "$sandbox/sync.log"
  return "$sync_rc"
}

echo "-> S4: shared-library skew classes must FAIL sync (rc 10 and rc 11)"
out="$(run_sync_with_extdeps_rc 10 '- 0.80.2 - - 1 0 - -')"; rc=$?
[ "${COOP_MATRIX_DEBUG:-0}" = "1" ] && printf 'DBG S4 rc=%s\n' "$rc" >&2
[ "$rc" -ne 0 ] && ok "rc-10 shared-lib skew -> sync exits non-zero" || ko "sync exited 0 on rc-10 skew"
case "$out" in
  *"shared-library skew remains after alignment"*) ok "rc-10 skew reported precisely" ;;
  *) ko "rc-10 message missing: $(printf '%s' "$out" | tail -2)" ;;
esac

out="$(run_sync_with_extdeps_rc 11 '- 0.80.2 - - 1 0 ^99.0.0 pi-web-access')"; rc=$?
[ "$rc" -ne 0 ] && ok "rc-11 agent-too-old skew -> sync exits non-zero" || ko "sync exited 0 on rc-11 skew"
case "$out" in
  *"provides older libraries"*) ok "rc-11 names the offending extension and floor" ;;
  *) ko "rc-11 detail missing: $(printf '%s' "$out" | tail -2)" ;;
esac

# --- S5: venvs dir comes straight from PIPX_LOCAL_VENVS (no doubling) ----------
mkdir -p "$TMP/pipxq"
printf '#!/bin/sh\n[ "$2" = "--value" ] && { printf "%%s\\n" "${COOP_FAKE_LOCAL_VENVS:?}"; exit 0; }\nexit 1\n' > "$TMP/pipxq/pipx"
chmod +x "$TMP/pipxq/pipx"
vd="$(HOME="$TMP/pipxq-home" COOP_PIPX_HOME='' PIPX_HOME='' \
  COOP_PIPX_BIN="$TMP/pipxq/pipx" COOP_FAKE_LOCAL_VENVS="$TMP/auth-venvs" \
  COOP_TEST_STUB_PATH="$TMP/pipxq" PATH="$TMP/pipxq:/usr/bin:/bin" \
  bash -c '. "'"$ROOT"'/lib/common.sh"; coop_pipx_venvs_dir')"
[ "$vd" = "$TMP/auth-venvs" ] \
  && ok "venv dir comes straight from PIPX_LOCAL_VENVS (no /venvs doubling)" \
  || ko "doubled/mangled venvs dir: $vd"

exit $fail
