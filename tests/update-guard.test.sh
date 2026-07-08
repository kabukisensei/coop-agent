#!/usr/bin/env bash
#
# Tests for the `coop update` tested-Pi-version guard (scripts/update.sh, issue #13):
#   - coop_minor_newer version comparison (lib/common.sh)
#   - `coop update --check` is a dry-run (prints the table, installs NOTHING)
#   - the gate decision: prompt-crossing / --yes / --pi-latest / decline -> pin
# No network: the registry query is mocked with COOP_PI_LATEST_OVERRIDE, and the gate
# stops before any install via COOP_UPDATE_GATE_DRYRUN. bash 3.2 compatible.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
COOP_ROOT="$ROOT"; export COOP_ROOT
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

# --- coop_minor_newer -----------------------------------------------------------
. "$ROOT/lib/common.sh"
mn() { coop_minor_newer "$1" "$2" && echo yes || echo no; }
[ "$(mn 0.99.0 0.80.2)" = yes ] && ok "coop_minor_newer: newer minor -> yes"   || ko "0.99.0 > 0.80.2 should be yes"
[ "$(mn 1.0.0  0.80.2)" = yes ] && ok "coop_minor_newer: newer major -> yes"   || ko "1.0.0 > 0.80.2 should be yes"
[ "$(mn 0.80.5 0.80.2)" = no  ] && ok "coop_minor_newer: same minor (newer patch) -> no" || ko "0.80.5 > 0.80.2 should be no"
[ "$(mn 0.79.0 0.80.2)" = no  ] && ok "coop_minor_newer: older -> no"          || ko "0.79.0 > 0.80.2 should be no"
[ "$(mn ''     0.80.2)" = no  ] && ok "coop_minor_newer: empty -> no"          || ko "empty should be no"

# --- stub PATH (records every install/upgrade to a marker) ----------------------
STUB="$(mktemp -d)"; MARKER="$STUB/INSTALLS"; export MARKER
trap 'rm -rf "$STUB"' EXIT
cat > "$STUB/pi" <<'EOF'
#!/bin/sh
[ "$1" = "--version" ] && { echo "pi 0.80.2"; exit 0; }
echo "PI $*" >> "$MARKER"; exit 0
EOF
cat > "$STUB/npm" <<'EOF'
#!/bin/sh
echo "NPM $*" >> "$MARKER"; exit 0
EOF
cat > "$STUB/pipx" <<'EOF'
#!/bin/sh
[ "$1" = "list" ] && { echo "   package coop-data-doc 0.26.0, installed using ..."; exit 0; }
echo "PIPX $*" >> "$MARKER"; exit 0
EOF
chmod +x "$STUB/pi" "$STUB/npm" "$STUB/pipx"

# --- --check is a dry-run -------------------------------------------------------
: > "$MARKER"
out="$(PATH="$STUB:$PATH" COOP_PI_LATEST_OVERRIDE=0.99.0 bash "$ROOT/scripts/update.sh" --check 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "--check exits 0" || ko "--check exit was $rc"
case "$out" in *"tested 0.80.2"*) ok "--check prints the pi tested version" ;; *) ko "--check missing pi tested version" ;; esac
case "$out" in *"latest 0.99.0"*) ok "--check prints the (mocked) latest" ;; *) ko "--check missing latest" ;; esac
[ ! -s "$MARKER" ] && ok "--check installed NOTHING" || { ko "--check ran installs:"; cat "$MARKER"; }

# --- gate decision (COOP_UPDATE_GATE_DRYRUN stops before any install) ------------
# Script args go after the script; the mocked latest + assume-yes are read from
# GATE_LATEST / GATE_YES so they land in the ENV, not the arg list.
gate() {
  ( PATH="$STUB:$PATH" COOP_UPDATE_GATE_DRYRUN=1 \
    COOP_PI_LATEST_OVERRIDE="${GATE_LATEST:-}" COOP_ASSUME_YES="${GATE_YES:-}" \
    bash "$ROOT/scripts/update.sh" "$@" 2>/dev/null </dev/null )
}

d="$(GATE_LATEST=0.99.0 gate)"
[ "$d" = "GATE pin:0.80.2" ] && ok "crossing the tested minor + declined -> pins to tested" || ko "expected 'GATE pin:0.80.2', got '$d'"

d="$(GATE_LATEST=0.99.0 GATE_YES=1 gate)"
[ "$d" = "GATE all" ] && ok "--yes / COOP_ASSUME_YES bypasses the gate (takes latest)" || ko "with --yes expected 'GATE all', got '$d'"

d="$(GATE_LATEST=0.99.0 gate --pi-latest)"
[ "$d" = "GATE all" ] && ok "--pi-latest bypasses the gate (takes latest)" || ko "with --pi-latest expected 'GATE all', got '$d'"

d="$(GATE_LATEST=0.80.5 gate)"
[ "$d" = "GATE all" ] && ok "a newer PATCH (same minor) is NOT gated" || ko "0.80.5 should not gate, got '$d'"

if [ "$fail" -ne 0 ]; then echo "  ✗ update-guard tests FAILED"; exit 1; fi
echo "  update-guard tests passed"
