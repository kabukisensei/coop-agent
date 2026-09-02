#!/usr/bin/env bash
#
# First-run continuation tests for the public `coop` command (Phase 4):
#   F1: plain `coop` on a fresh workstation runs onboarding, saves both files,
#       generates MCP config, and CONTINUES INTO PI.
#   F2: when onboarding FAILS, the launcher must stop with a clear error and
#       must not continue with a partially generated MCP configuration.
#
# Pi is a stub that records its invocation; the point is the launcher's control
# flow, not Pi itself. Onboarding needs a TTY (coop_maybe_onboard skips when
# stdin is redirected), so inputs are fed through `script`.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
[ -z "$PY" ] && { echo "python3 required"; exit 1; }

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKEBIN="$WORK/bin"; mkdir -p "$FAKEBIN"
MARKER="$WORK/marker"; mkdir -p "$MARKER"
cat > "$FAKEBIN/pi" <<EOF
#!/bin/sh
printf '%s\\n' "\$*" > "$MARKER/pi-args"
printf '%s\\n' "\${COOP_PRIME_MODEL_LOGIN:-}" > "$MARKER/pi-prime-login"
touch "$MARKER/pi-ran"
echo "STUB-PI-READY"
exit 0
EOF
chmod +x "$FAKEBIN/pi"

# Run `coop` under a real pty (tests/pty_drive.py) so coop_maybe_onboard sees
# an interactive terminal. Any extra environment must be exported by the caller.
run_coop_pty() { # <homedir> <answers> <transcript-out>
  local home="$1" answers="$2" outfile="$3"
  local ansfile; ansfile="$WORK/answers.$$"; printf '%s' "$answers" > "$ansfile"
  HOME="$home" COOP_DIR="${COOP_DIR_OVERRIDE:-$home}" PATH="$FAKEBIN:$PATH" COOP_SKIP_EXT_CHECK=1 \
    COOP_AZ_BIN=/nonexistent/az PTY_ANSWERS="$ansfile" PTY_OUT="$outfile" \
    "$PY" "$ROOT/tests/pty_drive.py" bash "$ROOT/bin/coop"
  local rc=$?
  cat "$outfile"
  return $rc
}

# Tester / balanced / no tenant / fabric y / modeling y / ADO n / learn y.
ONBOARD_ANSWERS=$'Tester\n2\nn\n\n\nn\n'

echo "→ F1: plain coop continues from first-run onboarding into pi"
F1_HOME="$WORK/f1-home"; mkdir -p "$F1_HOME"
F1_OUT="$(run_coop_pty "$F1_HOME" "$ONBOARD_ANSWERS" "$WORK/f1.out")"; F1_RC=$?
[ -f "$MARKER/pi-ran" ] \
  && ok "launcher continued into pi after onboarding" \
  || ko "pi was never launched after successful onboarding (rc=$F1_RC)"
[ -f "$F1_HOME/.coop/user.json" ] \
  && ok "user.json saved by first-run onboarding" || ko "user.json missing after first run"
[ -f "$F1_HOME/.coop/config" ] \
  && ok "integration config saved by first-run onboarding" || ko "config missing after first run"
[ -f "$F1_HOME/.coop/agent/mcp.json" ] \
  && ok "MCP configuration generated" || ko "mcp.json missing after first run"
case "$F1_OUT" in
  *"Setup complete. Starting Coop"*) ok "launch-triggered onboarding announces startup" ;;
  *) ko "'Setup complete. Starting Coop…' missing from first-run output" ;;
esac
case "$(cat "$MARKER/pi-args" 2>/dev/null)" in
  *extensions/coop-profile*) ok "launched pi loads coop-profile extension" ;;
  "") ko "no pi invocation recorded" ;;
  *) ko "pi args missing coop-profile: $(cat "$MARKER/pi-args")" ;;
esac
[ "$(cat "$MARKER/pi-prime-login" 2>/dev/null)" = "1" ] \
  && ok "fresh plain launch primes the real model login command" \
  || ko "fresh plain launch did not request model login"

echo "→ F2: failed onboarding stops the launcher"
rm -f "$MARKER/pi-ran" "$MARKER/pi-args" "$MARKER/pi-prime-login"
F2_HOME="$WORK/f2-home"; mkdir -p "$F2_HOME/.coop"
printf '{broken\n' > "$F2_HOME/.coop/config"   # malformed config -> onboard fails (rc 2)
F2_OUT="$(run_coop_pty "$F2_HOME" "$ONBOARD_ANSWERS" "$WORK/f2.out")"; F2_RC=$?
if [ -f "$MARKER/pi-ran" ]; then
  ko "launcher continued into pi DESPITE onboarding failure (rc=$F2_RC)"
else
  ok "launcher did not start pi after onboarding failure"
fi
[ "$F2_RC" -ne 0 ] \
  && ok "launcher exits non-zero on onboarding failure" \
  || ko "launcher exited 0 despite onboarding failure"
case "$F2_OUT" in
  *"onboard"*) ok "clear error names onboarding as the cause" ;;
  *) ko "error output does not mention onboarding: $(printf '%s' "$F2_OUT" | tail -3)" ;;
esac

exit $fail
