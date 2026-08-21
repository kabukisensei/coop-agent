#!/usr/bin/env bash
#
# Tests for the `coop update` tested-version guards (scripts/update.sh, issue #13):
#   - coop_minor_newer version comparison (lib/common.sh)
#   - `coop update --check` is a dry-run (prints the table, installs NOTHING)
#   - the Pi gate decision: prompt-crossing / --yes / --pi-latest / decline -> pin
#   - the pipx-tool + fabric-cicd gate (same rule, via the mocked PyPI latest)
# No network: the registry query is mocked with COOP_PI_LATEST_OVERRIDE /
# COOP_PYPI_LATEST_OVERRIDE-driven python3 stub, and the gate stops before any
# install via COOP_UPDATE_GATE_DRYRUN. bash 3.2 compatible.
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
[ "$1" = "list" ] && { echo "   package coop-data-doc 0.26.0, installed using ..."; echo "   package ms-fabric-cli 1.6.1, installed using ..."; exit 0; }
echo "PIPX $*" >> "$MARKER"; exit 0
EOF
# python3 stub: _pypi_latest invokes `python3 - <pkg>`; that form prints
# $PYPI_STUB_VER (empty => latest unknown => no pipx/fabric-cicd gate). Everything
# else (coop_yaml_get's lib/_yaml.py) must delegate to the REAL python3 — otherwise
# the mocked YAML reads break the Pi gate, too.
REAL_PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
cat > "$STUB/python3" <<EOF
#!/bin/sh
[ "\$1" = "-" ] && { echo "\${PYPI_STUB_VER:-}"; exit 0; }
exec $REAL_PY "\$@"
EOF
chmod +x "$STUB/pi" "$STUB/npm" "$STUB/pipx" "$STUB/python3"

# --- --check is a dry-run -------------------------------------------------------
: > "$MARKER"
out="$(PATH="$STUB:$PATH" COOP_PI_LATEST_OVERRIDE=0.99.0 bash "$ROOT/scripts/update.sh" --check 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "--check exits 0" || ko "--check exit was $rc"
case "$out" in *"expected 0.80.2"*) ok "--check prints the pi expected version" ;; *) ko "--check missing pi expected version" ;; esac
case "$out" in *"status ok"*|*"status older"*|*"status newer-than-tested"*|*"status wrong-version"*|*"status missing"*) ok "--check prints a status column" ;; *) ko "--check missing status column" ;; esac
case "$out" in *"@microsoft/powerbi-report-authoring-cli"*) ok "--check lists npm authoring tools" ;; *) ko "--check missing npm authoring tools" ;; esac
# --check may query npm ls for current versions, but must not install/upgrade anything.
grep -vE '^NPM ls -g --depth=0 ' "$MARKER" > "$MARKER.noinstall" 2>/dev/null || true
[ ! -s "$MARKER.noinstall" ] && ok "--check installed NOTHING" || { ko "--check ran installs:"; cat "$MARKER"; }
rm -f "$MARKER.noinstall"

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

# --- pipx tool + fabric-cicd gate (mock latest via the python3 stub) ------------
# Stub latest 2.0.0 crosses the tested MINOR of every pipx tool AND fabric-cicd:
# declining pins each to its tested version (pi stays pinned too, as above).
full_pin="GATE pin:0.80.2,coop-data-doc=1.1.0,coop-sql-review=0.15.2,coop-dax-review=0.22.0,ms-fabric-cli=1.6.1,fabric-cicd=1.1.0"
d="$(GATE_LATEST=0.99.0 PYPI_STUB_VER=2.0.0 gate)"
[ "$d" = "$full_pin" ] && ok "crossing tested minors + declined -> pins pi, every pipx tool, and fabric-cicd to tested" || ko "expected '$full_pin', got '$d'"

d="$(GATE_LATEST=0.99.0 PYPI_STUB_VER=2.0.0 GATE_YES=1 gate)"
[ "$d" = "GATE all" ] && ok "--yes / COOP_ASSUME_YES takes latest for pipx tools and fabric-cicd too" || ko "with --yes expected 'GATE all', got '$d'"

# A pipx latest at/under the tested MINOR is NOT gated (per-tool; sql-review's tested
# 0.15.2 is crossed by 0.16.0 but 1.0.0 is older than 1.1.0 for data-doc).
d="$(GATE_LATEST=0.80.5 PYPI_STUB_VER=1.0.0 gate)"
case "$d" in
  "GATE pin:"*coop-sql-review=0.15.2*) ok "pipx gate is per-tool: only genuinely-crossed tools pin (sql-review 0.15.2 <- 1.0.0)" ;;
  *) ko "expected sql-review pin for 1.0.0 latest, got '$d'" ;;
esac

if [ "$fail" -ne 0 ]; then echo "  ✗ update-guard tests FAILED"; exit 1; fi
echo "  update-guard tests passed"
