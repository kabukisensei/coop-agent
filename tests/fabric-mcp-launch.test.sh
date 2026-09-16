#!/usr/bin/env bash
set -euo pipefail
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
cat > "$BIN/pi" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$COOP_TEST_MARKER/pi-argv"
case "${COOP_TEST_EXPECT_TOKEN:-present}" in
  present) [ "${COOP_FABRIC_MCP_TOKEN:-}" = "$COOP_TEST_TOKEN" ] || exit 41 ;;
  absent) [ -z "${COOP_FABRIC_MCP_TOKEN:-}" ] || exit 42 ;;
esac
printf '%s\n' 'pi-launched' > "$COOP_TEST_MARKER/pi-state"
SH
chmod +x "$BIN/az" "$BIN/pi"

run_coop() {
  HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
    PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
    COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
    COOP_TEST_AZ_MODE="${COOP_TEST_AZ_MODE:-ok}" \
    COOP_TEST_EXPECT_TOKEN="${COOP_TEST_EXPECT_TOKEN:-present}" \
    bash "$ROOT/bin/coop" pi --fixture
}

out="$(run_coop 2>"$TMP/success.err")"
[ -f "$MARKER/pi-state" ]
[ "$out" = "" ]
! grep -F "$TOKEN" "$TMP/success.err" "$MARKER/pi-argv" "$MARKER/az-argv" >/dev/null
case "$(cat "$MARKER/az-argv")" in
  'account get-access-token --resource https://api.fabric.microsoft.com --output json') ;;
  *) echo 'unexpected Azure CLI argv' >&2; exit 1 ;;
esac

rm -f "$MARKER/pi-state"
COOP_TEST_AZ_MODE=auth COOP_TEST_EXPECT_TOKEN=absent \
COOP_FABRIC_MCP_TOKEN='stale-inherited-token' run_coop >"$TMP/fail.out" 2>"$TMP/fail.err"
[ -f "$MARKER/pi-state" ]
grep -F 'Azure authentication is required' "$TMP/fail.err" >/dev/null
! grep -F "$TOKEN" "$TMP/fail.out" "$TMP/fail.err" "$MARKER/pi-argv" >/dev/null

COOP_FABRIC_MCP_TOKEN='stale-inherited-token' HOME="$HOME_DIR" PATH="$BIN:$PATH" \
  COOP_AGENT_DIR="$AGENT_DIR" PI_CODING_AGENT_DIR="$AGENT_DIR" \
  bash "$ROOT/bin/coop" launch-spec --json > "$TMP/launch-spec.json"
python3 - "$TMP/launch-spec.json" <<'PY'
import json, sys
spec = json.load(open(sys.argv[1], encoding="utf-8"))
assert "COOP_FABRIC_MCP_TOKEN" not in spec.get("env", {})
assert "stale-inherited-token" not in json.dumps(spec)
PY

# A damaged/unexecutable helper must not block raw Pi or coop web. The public
# web entrypoint must fall back to Node for launch-spec JSON, then launch Pi
# without inheriting a stale bearer even though its Python helper exits nonzero.
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
rm -f "$MARKER/pi-state"
COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" \
  run_coop >"$TMP/helper-fail.out" 2>"$TMP/helper-fail.err"
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/helper-fail.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/helper-fail.out" "$TMP/helper-fail.err" >/dev/null

rm -f "$MARKER/pi-state"
HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
  PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
  COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" \
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  bash "$ROOT/bin/coop" --fixture >"$TMP/normal-helper-fail.out" 2>"$TMP/normal-helper-fail.err"
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/normal-helper-fail.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/normal-helper-fail.out" "$TMP/normal-helper-fail.err" >/dev/null

rm -f "$MARKER/pi-state"
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
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/web-helper-fail.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/web-helper-fail.out" "$TMP/web-helper-fail.err" >/dev/null
kill "$WEB_PID" >/dev/null 2>&1 || true
wait "$WEB_PID" 2>/dev/null || true
WEB_PID=""

# A zero-exit helper that emits a valid-looking token frame plus unexpected
# stderr must be rejected; the terminal frame makes merged output invalid.
rm -f "$MARKER/pi-state"
COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
  COOP_TEST_HELPER_MODE=success-stderr \
  run_coop >"$TMP/helper-stderr.out" 2>"$TMP/helper-stderr.err"
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/helper-stderr.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/helper-stderr.out" "$TMP/helper-stderr.err" "$MARKER/pi-argv" >/dev/null
! grep -F "$HELPER_TOKENLIKE" "$TMP/helper-stderr.out" "$TMP/helper-stderr.err" "$MARKER/pi-argv" >/dev/null

rm -f "$MARKER/pi-state"
HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
  PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
  COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
  COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
  COOP_TEST_HELPER_MODE=success-stderr \
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
  bash "$ROOT/bin/coop" --fixture >"$TMP/normal-stderr.out" 2>"$TMP/normal-stderr.err"
[ -f "$MARKER/pi-state" ]
grep -F 'Fabric Warehouse MCP unavailable: token helper failed' "$TMP/normal-stderr.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/normal-stderr.out" "$TMP/normal-stderr.err" "$MARKER/pi-argv" >/dev/null
! grep -F "$HELPER_TOKENLIKE" "$TMP/normal-stderr.out" "$TMP/normal-stderr.err" "$MARKER/pi-argv" >/dev/null

rm -f "$MARKER/pi-state"
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
grep -F 'Fabric Warehouse MCP unavailable: token helper returned invalid output' "$TMP/web-stderr.err" >/dev/null
! grep -F "$HELPER_DIAGNOSTIC" "$TMP/web-stderr.out" "$TMP/web-stderr.err" "$MARKER/pi-argv" >/dev/null
! grep -F "$HELPER_TOKENLIKE" "$TMP/web-stderr.out" "$TMP/web-stderr.err" "$MARKER/pi-argv" >/dev/null
kill "$WEB_PID" >/dev/null 2>&1 || true
wait "$WEB_PID" 2>/dev/null || true
WEB_PID=""

# Control bytes and even whitespace-only stderr are contamination. Exercise all
# three public POSIX launch paths; each must continue without any bearer.
for HELPER_MODE in control-token whitespace-stderr; do
  rm -f "$MARKER/pi-state"
  COOP_TEST_EXPECT_TOKEN=absent COOP_FABRIC_MCP_TOKEN='stale-inherited-token' \
    COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
    COOP_TEST_HELPER_MODE="$HELPER_MODE" run_coop \
    >"$TMP/$HELPER_MODE-raw.out" 2>"$TMP/$HELPER_MODE-raw.err"
  [ -f "$MARKER/pi-state" ]
  grep -F 'Fabric Warehouse MCP unavailable:' "$TMP/$HELPER_MODE-raw.err" >/dev/null

  rm -f "$MARKER/pi-state"
  HOME="$HOME_DIR" PATH="$BIN:$PATH" COOP_AGENT_DIR="$AGENT_DIR" \
    PI_CODING_AGENT_DIR="$AGENT_DIR" COOP_NO_ONBOARD=1 COOP_SKIP_EXT_CHECK=1 \
    COOP_SKIP_AZ=1 COOP_TEST_MARKER="$MARKER" COOP_TEST_TOKEN="$TOKEN" \
    COOP_TEST_HELPER_DIAGNOSTIC="$HELPER_DIAGNOSTIC" COOP_TEST_HELPER_TOKENLIKE="$HELPER_TOKENLIKE" \
    COOP_TEST_HELPER_MODE="$HELPER_MODE" COOP_TEST_EXPECT_TOKEN=absent \
    COOP_FABRIC_MCP_TOKEN='stale-inherited-token' bash "$ROOT/bin/coop" --fixture \
    >"$TMP/$HELPER_MODE-normal.out" 2>"$TMP/$HELPER_MODE-normal.err"
  [ -f "$MARKER/pi-state" ]
  grep -F 'Fabric Warehouse MCP unavailable:' "$TMP/$HELPER_MODE-normal.err" >/dev/null

  rm -f "$MARKER/pi-state"
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
  grep -F 'Fabric Warehouse MCP unavailable:' "$TMP/$HELPER_MODE-web.err" >/dev/null
  kill "$WEB_PID" >/dev/null 2>&1 || true
  wait "$WEB_PID" 2>/dev/null || true
  WEB_PID=""
done

# Exercise the public web dispatcher with Python genuinely absent from PATH.
# Only the commands needed by this bounded path are exposed in the fixture bin.
NO_PY_BIN="$TMP/no-python-bin"
mkdir -p "$NO_PY_BIN"
for cmd in dirname find sort readlink uname mkdir date tr sed git; do
  cmd_path="$(command -v "$cmd" 2>/dev/null || true)"
  if [ -n "$cmd_path" ]; then ln -s "$cmd_path" "$NO_PY_BIN/$cmd"; fi
done
ln -s "$(command -v node)" "$NO_PY_BIN/node"
ln -s "$BIN/pi" "$NO_PY_BIN/pi"
rm -f "$MARKER/pi-state"
PORT=$((21000 + ($$ % 19000)))
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
grep -F 'Fabric Warehouse MCP unavailable: token helper Python is unavailable' "$TMP/web-no-python.err" >/dev/null
kill "$WEB_PID" >/dev/null 2>&1 || true
wait "$WEB_PID" 2>/dev/null || true
WEB_PID=""

! grep -R -F "$TOKEN" "$HOME_DIR" >/dev/null
printf '  ✓ Fabric MCP token is launch-only, fail-soft, and absent from argv/config/output\n'
