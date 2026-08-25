#!/usr/bin/env bash
#
# Tests for `coop update` fleet-mode semantics (scripts/update.sh, round-2 #12):
#   - `coop update --check` is a dry-run (prints the table, installs NOTHING)
#   - NORMAL mode pins everything to the release manifest: no registry queries,
#     no prompts — COOP_UPDATE_GATE_DRYRUN prints `GATE pin:<manifest pi version>`
#   - `--edge` is the only latest/upstream mode: `GATE all`
#   - `--pi-latest` is a deprecated alias for --edge
# bash 3.2 compatible.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
COOP_ROOT="$ROOT"; export COOP_ROOT
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

# --- stub PATH (records every install/upgrade to a marker) ----------------------
STUB="$(mktemp -d)"; MARKER="$STUB/INSTALLS"; export MARKER
trap 'rm -rf "$STUB"' EXIT
cat > "$STUB/pi" <<'EOF'
#!/bin/sh
[ "$1" = "--version" ] && { echo "pi 0.84.3"; exit 0; }
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
chmod +x "$STUB/pi" "$STUB/npm" "$STUB/pipx"

# --- --check is a dry-run -------------------------------------------------------
: > "$MARKER"
out="$(PATH="$STUB:$PATH" bash "$ROOT/scripts/update.sh" --check 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && ok "--check exits 0" || ko "--check exit was $rc"
case "$out" in *"expected 0.84.3"*) ok "--check prints the pi expected version" ;; *) ko "--check missing pi expected version" ;; esac
case "$out" in *"status ok"*|*"status older"*|*"status newer-than-tested"*|*"status wrong-version"*|*"status missing"*) ok "--check prints a status column" ;; *) ko "--check missing status column" ;; esac
case "$out" in *"@microsoft/powerbi-report-authoring-cli"*) ok "--check lists npm authoring tools" ;; *) ko "--check missing npm authoring tools" ;; esac
# --check may query npm ls for current versions, but must not install/upgrade anything.
grep -vE '^NPM ls -g --depth=0 ' "$MARKER" > "$MARKER.noinstall" 2>/dev/null || true
[ ! -s "$MARKER.noinstall" ] && ok "--check installed NOTHING" || { ko "--check ran installs:"; cat "$MARKER"; }
rm -f "$MARKER.noinstall"

# --- fleet-mode decision (COOP_UPDATE_GATE_DRYRUN stops before any install) ------
gate() {
  ( PATH="$STUB:$PATH" COOP_UPDATE_GATE_DRYRUN=1 \
    bash "$ROOT/scripts/update.sh" "$@" 2>/dev/null </dev/null )
}

d="$(gate)"
[ "$d" = "GATE pin:0.84.3" ] && ok "normal mode pins Pi to the release manifest" || ko "expected 'GATE pin:0.84.3', got '$d'"

d="$(gate --edge)"
[ "$d" = "GATE all" ] && ok "--edge is the only latest/upstream mode" || ko "with --edge expected 'GATE all', got '$d'"

d="$(gate --pi-latest)"
[ "$d" = "GATE all" ] && ok "--pi-latest is a deprecated alias for --edge" || ko "with --pi-latest expected 'GATE all', got '$d'"

# Normal mode must not query latest versions merely to ask about them: the stub PATH
# has no `npm view`-capable registry output beyond `ls`, and the decision is made
# without COOP_ASSUME_YES or stdin (no prompts can fire).
d="$(GATE_YES_UNSET=1 gate </dev/null)"
[ "$d" = "GATE pin:0.84.3" ] && ok "normal mode needs no prompt or --yes to pin" || ko "normal mode decision changed: '$d'"

if [ "$fail" -ne 0 ]; then echo "  ✗ update-guard tests FAILED"; exit 1; fi
echo "  update-guard tests passed"
