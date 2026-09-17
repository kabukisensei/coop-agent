#!/usr/bin/env bash
set -Eeuo pipefail
PHASE='setup'
report_fixture_failure() {
  local rc="$1"
  printf 'Fabric MCP fixture failed at phase=%s rc=%d\n' "$PHASE" "$rc" >&2
  return "$rc"
}
trap 'report_fixture_failure "$?"' ERR
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
WEB_PID=""
cleanup() {
  if [ -n "$WEB_PID" ]; then kill "$WEB_PID" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
HOME_DIR="$TMP/home"
AGENT_DIR="$HOME_DIR/.coop/agent"
BIN="$TMP/bin"
MARKER="$TMP/marker"
mkdir -p "$AGENT_DIR" "$BIN" "$MARKER"
if [ "${OS:-}" = Windows_NT ]; then
  COOP_TEST_MARKER_NATIVE="$(cygpath -w "$MARKER")"
  export COOP_TEST_MARKER_NATIVE
fi
TOKEN='fabric-launch-canary-7e5a3c'
HELPER_DIAGNOSTIC='untrusted-helper-diagnostic-93b75a'
HELPER_TOKENLIKE='tokenlike-helper-value-2309'

cat > "$AGENT_DIR/mcp.json" <<'JSON'
{
  "mcpServers": {
    "fabric-sqlendpoint": {
      "url": "https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint",
      "auth": "bearer",
      "bearerTokenEnv": "COOP_FABRIC_MCP_TOKEN",
      "lifecycle": "lazy"
    }
  },
  "_coop": {"schema_version": 1, "managed_servers": ["fabric-sqlendpoint"]}
}
JSON

cat > "$BIN/az" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$COOP_TEST_MARKER/az-argv"
case "${COOP_TEST_AZ_MODE:-ok}" in
  ok) printf '{"accessToken":"%s"}\n' "$COOP_TEST_TOKEN" ;;
  auth) printf '%s\n' "ERROR: Please run 'az login' to setup account." >&2; exit 1 ;;
  fail) printf '%s\n' 'ERROR: token command failed' >&2; exit 2 ;;
esac
SH
if [ "${OS:-}" = Windows_NT ]; then
  cat > "$BIN/az.cmd" <<'CMD'
@echo off
>"%COOP_TEST_MARKER_NATIVE%\az-argv" echo %*
if "%COOP_TEST_AZ_MODE%"=="auth" (
  >&2 echo ERROR: Please run 'az login' to setup account.
  exit /b 1
)
if "%COOP_TEST_AZ_MODE%"=="fail" (
  >&2 echo ERROR: token command failed
  exit /b 2
)
echo {"accessToken":"%COOP_TEST_TOKEN%"}
CMD
fi
cat > "$BIN/pi" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$COOP_TEST_MARKER/pi-argv"
case "${COOP_TEST_EXPECT_TOKEN:-present}" in
  present) [ "${COOP_FABRIC_MCP_TOKEN:-}" = "$COOP_TEST_TOKEN" ] || exit 41 ;;
  absent) [ -z "${COOP_FABRIC_MCP_TOKEN:-}" ] || exit 42 ;;
esac
printf '%s\n' 'pi-launched' > "$COOP_TEST_MARKER/pi-state"
SH
if [ "${OS:-}" = Windows_NT ]; then
  cat > "$BIN/pi.cmd" <<'CMD'
@echo off
>"%COOP_TEST_MARKER_NATIVE%\pi-argv" echo %*
if "%COOP_TEST_EXPECT_TOKEN%"=="present" if not "%COOP_FABRIC_MCP_TOKEN%"=="%COOP_TEST_TOKEN%" exit /b 41
if "%COOP_TEST_EXPECT_TOKEN%"=="absent" if not "%COOP_FABRIC_MCP_TOKEN%"=="" exit /b 42
>"%COOP_TEST_MARKER_NATIVE%\pi-state" echo pi-launched
exit /b 0
CMD
fi
chmod +x "$BIN/az" "$BIN/pi"

run_coop() {
  HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
    PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
    COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
    COOP_TEST_AZ_MODE="${COOP_TEST_AZ_MODE:-ok}" \
    COOP_TEST_EXPECT_TOKEN="${COOP_TEST_EXPECT_TOKEN:-present}" \
    bash "$ROOT/bin/coop" pi --fixture
}

PHASE='initial-token'
out="$(run_coop 2>"$TMP/success.err")"
[ -f "$MARKER/pi-state" ]
[ "$out" = "" ]
! grep -F "$TOKEN" "$TMP/success.err" "$MARKER/pi-argv" "$MARKER/az-argv" >/dev/null
case "$(cat "$MARKER/az-argv")" in
  'account get-access-token --resource https://api.fabric.microsoft.com --output json') ;;
  *) echo 'unexpected Azure CLI argv' >&2; exit 1 ;;
esac

PHASE='auth-failure'
rm -f "$MARKER/pi-state"
COOP_TEST_AZ_MODE=auth COOP_TEST_EXPECT_TOKEN=absent \
COOP_FABRIC_MCP_TOKEN='stale-inherited-token' run_coop >"$TMP/fail.out" 2>"$TMP/fail.err"
[ -f "$MARKER/pi-state" ]
grep -F 'Azure authentication is required' "$TMP/fail.err" >/dev/null
! grep -F "$TOKEN" "$TMP/fail.out" "$TMP/fail.err" "$MARKER/pi-argv" >/dev/null

PHASE='launch-spec-stale-token'
COOP_FABRIC_MCP_TOKEN='stale-inherited-token' HOME="$HOME_DIR" PATH="$BIN:$PATH" \
  COOP_AGENT_DIR="$AGENT_DIR" PI_CODING_AGENT_DIR="$AGENT_DIR" \
  bash "$ROOT/bin/coop" launch-spec --json > "$TMP/launch-spec.json"
python3 - "$TMP/launch-spec.json" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1], encoding="utf-8"))
assert "COOP_FABRIC_MCP_TOKEN" not in spec.get("env", {})
assert "stale-inherited-token" not in json.dumps(spec)
PY

# A failing helper must not block raw Pi or coop web. On Windows, real Python
# injects controlled output and writes an execution marker so cannot-launch is
# distinct from executed-and-rejected. The stale bearer must never survive.
if [ "${OS:-}" = Windows_NT ]; then
  HELPER_FIXTURE="$TMP/python-fixture"
  mkdir -p "$HELPER_FIXTURE"
  cat > "$HELPER_FIXTURE/sitecustomize.py" <<'PY'
import os
import sys
from pathlib import Path

if (
    len(sys.argv) >= 2
    and Path(sys.argv[0]).name.lower() == "warehouse_mcp.py"
    and sys.argv[1] == "launch-token"
):
    mode = os.environ.get("COOP_TEST_HELPER_MODE", "failure")
    marker = Path(os.environ["COOP_TEST_HELPER_MARKER"]) / f"bash-helper-{mode}.reached"
    marker.write_bytes(b"executed\n")
    if mode == "success-stderr":
        tokenlike = os.environ["COOP_TEST_HELPER_TOKENLIKE"].encode("ascii")
        diagnostic = os.environ["COOP_TEST_HELPER_DIAGNOSTIC"].encode("ascii")
        os.write(1, b"token\t" + tokenlike + b"\tend")
        os.write(2, diagnostic + b"\n")
        os._exit(0)
    if mode == "control-token":
        os.write(1, b"token\tbad\x07token\tend")
        os._exit(0)
    if mode == "whitespace-stderr":
        tokenlike = os.environ["COOP_TEST_HELPER_TOKENLIKE"].encode("ascii")
        os.write(1, b"token\t" + tokenlike + b"\tend")
        os.write(2, b"\n")
        os._exit(0)
    diagnostic = os.environ["COOP_TEST_HELPER_DIAGNOSTIC"].encode("ascii")
    os.write(2, diagnostic + b"\n")
    os._exit(7)
PY
  # Native Windows Python does not interpret Git-Bash /tmp paths. Convert both
  # import and marker roots explicitly; otherwise the controlled helper never
  # executes and a generic rejection can falsely satisfy the fixture.
  HELPER_FIXTURE_NATIVE="$(cygpath -w "$HELPER_FIXTURE")"
  HELPER_MARKER_NATIVE="$(cygpath -w "$MARKER")"
  export COOP_TEST_HELPER_MARKER="$HELPER_MARKER_NATIVE"
  export PYTHONPATH="$HELPER_FIXTURE_NATIVE${PYTHONPATH:+;$PYTHONPATH}"
else
  cat > "$BIN/python3" <<'SH'
#!/bin/sh
if [ "${1:-}" = - ]; then
  cat >/dev/null
  printf '{"bin":"pi","args":[],"env":{"PI_CODING_AGENT_DIR":"%s"}}\n' "$PI_CODING_AGENT_DIR"
  exit 0
fi
case "${COOP_TEST_HELPER_MODE:-failure}" in
  success-stderr)
    printf 'token\t%s\tend' "$COOP_TEST_HELPER_TOKENLIKE"
    printf '%s\n' "$COOP_TEST_HELPER_DIAGNOSTIC" >&2
    exit 0
    ;;
  control-token)
    printf 'token\tbad\007token\tend'
    exit 0
    ;;
  whitespace-stderr)
    printf 'token\t%s\tend' "$COOP_TEST_HELPER_TOKENLIKE"
    printf '\n' >&2
    exit 0
    ;;
esac
printf '%s\n' "$COOP_TEST_HELPER_DIAGNOSTIC" >&2
exit 7
SH
  chmod +x "$BIN/python3"
fi

assert_windows_helper_executed() {
  mode="$1"
  if [ "${OS:-}" = Windows_NT ]; then
    marker_path="$MARKER/bash-helper-$mode.reached"
    [ -f "$marker_path" ] || {
      echo "Windows Bash helper mode $mode did not execute; cannot-launch is not executed-and-rejected" >&2
      exit 1
    }
    [ "$(cat "$marker_path")" = executed ] || {
      echo "Windows Bash helper mode $mode execution marker is invalid" >&2
      exit 1
    }
  fi
}
PHASE='helper-failure-raw'
rm -f "$MARKER/pi-state" "$MARKER/bash-helper-failure.reached"
COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" \
  run_coop >"$TMP/helper-fail.out" 2>"$TMP/helper-fail.err"
assert_windows_helper_executed failure
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/helper-fail.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/helper-fail.out" "$TMP/helper-fail.err" >/dev/null

PHASE='helper-failure-normal'
rm -f "$MARKER/pi-state" "$MARKER/bash-helper-failure.reached"
HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
  PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
  COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" \
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  bash "$ROOT/bin/coop" --fixture >"$TMP/normal-helper-fail.out" 2>"$TMP/normal-helper-fail.err"
assert_windows_helper_executed failure
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/normal-helper-fail.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/normal-helper-fail.out" "$TMP/normal-helper-fail.err" >/dev/null

PHASE='helper-failure-web'
rm -f "$MARKER/pi-state" "$MARKER/bash-helper-failure.reached"
PORT=$((20000 + ($$ % 20000)))
HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
  PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
  COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" \
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  COOP_WEB_NO_OPEN=1 bash "$ROOT/bin/coop" web --port "$PORT" \
  >"$TMP/web-helper-fail.out" 2>"$TMP/web-helper-fail.err" &
WEB_PID=$!
i=0
while [ ! -f "$MARKER/pi-state" ] && [ "$i" -lt 160 ]; do
  sleep 0.05
  i=$((i + 1))
done
[ -f "$MARKER/pi-state" ]
assert_windows_helper_executed failure
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/web-helper-fail.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/web-helper-fail.out" "$TMP/web-helper-fail.err" >/dev/null
kill "$WEB_PID" >/dev/null 2>&1 || true
wait "$WEB_PID" 2>/dev/null || true
WEB_PID=""

# A zero-exit helper that emits a valid-looking token frame plus unexpected
# stderr must be rejected; the terminal frame makes merged output invalid.
PHASE='helper-stderr-raw'
rm -f "$MARKER/pi-state" "$MARKER/bash-helper-success-stderr.reached"
COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
  COOP_TEST_HELPER_MODE=success-stderr \
  run_coop >"$TMP/helper-stderr.out" 2>"$TMP/helper-stderr.err"
assert_windows_helper_executed success-stderr
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/helper-stderr.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/helper-stderr.out" "$TMP/helper-stderr.err" "$MARKER/pi-argv" >/dev/null
! grep -F "$HELPER_TOKENLIKE" "$TMP/helper-stderr.out" "$TMP/helper-stderr.err" "$MARKER/pi-argv" >/dev/null

PHASE='helper-stderr-normal'
rm -f "$MARKER/pi-state" "$MARKER/bash-helper-success-stderr.reached"
HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
  PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
  COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
  COOP_TEST_HELPER_MODE=success-stderr \
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  bash "$ROOT/bin/coop" --fixture >"$TMP/normal-stderr.out" 2>"$TMP/normal-stderr.err"
assert_windows_helper_executed success-stderr
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/normal-stderr.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/normal-stderr.out" "$TMP/normal-stderr.err" "$MARKER/pi-argv" >/dev/null
! grep -F "$HELPER_TOKENLIKE" "$TMP/normal-stderr.out" "$TMP/normal-stderr.err" "$MARKER/pi-argv" >/dev/null

PHASE='helper-stderr-web'
rm -f "$MARKER/pi-state" "$MARKER/bash-helper-success-stderr.reached"
PORT=$((20500 + ($$ % 19500)))
HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
  PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
  COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
  COOP_TEST_HELPER_MODE=success-stderr \
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  COOP_WEB_NO_OPEN=1 bash "$ROOT/bin/coop" web --port "$PORT" \
  >"$TMP/web-stderr.out" 2>"$TMP/web-stderr.err" &
WEB_PID=$!
i=0
while [ ! -f "$MARKER/pi-state" ] && [ "$i" -lt 160 ]; do
  sleep 0.05
  i=$((i + 1))
done
[ -f "$MARKER/pi-state" ]
assert_windows_helper_executed success-stderr
grep -F 'Fabric Warehouse MCP unavailable: token helper returned invalid output' "$TMP/web-stderr.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/web-stderr.out" "$TMP/web-stderr.err" "$MARKER/pi-argv" >/dev/null
! grep -F "$HELPER_TOKENLIKE" "$TMP/web-stderr.out" "$TMP/web-stderr.err" "$MARKER/pi-argv" >/dev/null
kill "$WEB_PID" >/dev/null 2>&1 || true
wait "$WEB_PID" 2>/dev/null || true
WEB_PID=""

# Control bytes and even whitespace-only stderr are contamination. Exercise all
# three public POSIX launch paths; each must continue without any bearer.
for HELPER_MODE in control-token whitespace-stderr; do
  PHASE="$HELPER_MODE-raw"
  rm -f "$MARKER/pi-state" "$MARKER/bash-helper-$HELPER_MODE.reached"
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
    COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
    COOP_TEST_HELPER_MODE="$HELPER_MODE" run_coop \
    >"$TMP/$HELPER_MODE-raw.out" 2>"$TMP/$HELPER_MODE-raw.err"
  assert_windows_helper_executed "$HELPER_MODE"
  [ -f "$MARKER/pi-state" ]
  grep -F 'Fabric Warehouse MCP unavailable:' "$TMP/$HELPER_MODE-raw.err" >/dev/null

  PHASE="$HELPER_MODE-normal"
  rm -f "$MARKER/pi-state" "$MARKER/bash-helper-$HELPER_MODE.reached"
  HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
    PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
    COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
    COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
    COOP_TEST_HELPER_MODE="$HELPER_MODE" COOP_TEST_EXPECT_TOKEN=absent \
    COOP_FABRIC_MCP_TOKEN='stale-inherited-token' bash "$ROOT/bin/coop" --fixture \
    >"$TMP/$HELPER_MODE-normal.out" 2>"$TMP/$HELPER_MODE-normal.err"
  assert_windows_helper_executed "$HELPER_MODE"
  [ -f "$MARKER/pi-state" ]
  grep -F 'Fabric Warehouse MCP unavailable:' "$TMP/$HELPER_MODE-normal.err" >/dev/null

  PHASE="$HELPER_MODE-web"
  rm -f "$MARKER/pi-state" "$MARKER/bash-helper-$HELPER_MODE.reached"
  PORT=$((21500 + ($$ + ${#HELPER_MODE}) % 18000))
  HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
    PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
    COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
    COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
    COOP_TEST_HELPER_MODE="$HELPER_MODE" COOP_TEST_EXPECT_TOKEN=absent \
    COOP_FABRIC_MCP_TOKEN='stale-inherited-token' COOP_WEB_NO_OPEN=1 \
    bash "$ROOT/bin/coop" web --port "$PORT" \
    >"$TMP/$HELPER_MODE-web.out" 2>"$TMP/$HELPER_MODE-web.err" &
  WEB_PID=$!
  i=0
  while [ ! -f "$MARKER/pi-state" ] && [ "$i" -lt 160 ]; do sleep 0.05; i=$((i + 1)); done
  [ -f "$MARKER/pi-state" ]
  assert_windows_helper_executed "$HELPER_MODE"
  grep -F 'Fabric Warehouse MCP unavailable:' "$TMP/$HELPER_MODE-web.err" >/dev/null
  kill "$WEB_PID" >/dev/null 2>&1 || true
  wait "$WEB_PID" 2>/dev/null || true
  WEB_PID=""
done

# Exercise the public web dispatcher with Python genuinely absent from PATH.
# Windows Git Bash cannot model this synthetic minimal-PATH boundary reliably
# across native Node -> cmd/PATHEXT. Web is retired from the terminal release,
# so report this one subcase as unsupported while preserving every other mode.
if [ "${OS:-}" = Windows_NT ]; then
  printf '  - SKIP (unsupported): Windows Git-Bash web/no-Python minimal-PATH fixture\n'
else
  PHASE='web-no-python'
  NO_PY_BIN="$TMP/no-python-bin"
  mkdir -p "$NO_PY_BIN"
  for cmd in dirname find sort readlink uname mkdir date tr sed git; do
    cmd_path="$(command -v "$cmd" 2>/dev/null || true)"
    if [ -n "$cmd_path" ]; then ln -s "$cmd_path" "$NO_PY_BIN/$cmd"; fi
  done
  ln -s "$(command -v node)" "$NO_PY_BIN/node"
  ln -s "$BIN/pi" "$NO_PY_BIN/pi"
  rm -f "$MARKER/pi-state" "$MARKER/pi-argv"
  PORT=$((21000 + ($$ % 19000)))
  PHASE='web-no-python-launch'
  HOME="$HOME_DIR" PATH="$NO_PY_BIN" COOP_AGENT_DIR="$AGENT_DIR" \
    PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
    COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
    COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
    COOP_WEB_NO_OPEN=1 "$BASH" "$ROOT/bin/coop" web --port "$PORT" \
    >"$TMP/web-no-python.out" 2>"$TMP/web-no-python.err" &
  WEB_PID=$!
  i=0
  while [ ! -f "$MARKER/pi-state" ] && [ "$i" -lt 160 ]; do
    sleep 0.05
    i=$((i + 1))
  done
  [ -f "$MARKER/pi-state" ]
  PHASE='web-no-python-warning'
  grep -F 'Fabric Warehouse MCP unavailable: token helper Python is unavailable' "$TMP/web-no-python.err" >/dev/null
  kill "$WEB_PID" >/dev/null 2>&1 || true
  wait "$WEB_PID" 2>/dev/null || true
  WEB_PID=""
fi

! grep -R -F "$TOKEN" "$HOME_DIR" >/dev/null
printf '  ✓ Fabric MCP token is launch-only, fail-soft, and absent from argv/config/output\n'
