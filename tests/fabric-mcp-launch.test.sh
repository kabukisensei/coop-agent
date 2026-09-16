#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HOME_DIR="$TMP/home"
AGENT_DIR="$HOME_DIR/.coop/agent"
BIN="$TMP/bin"
MARKER="$TMP/marker"
mkdir -p "$AGENT_DIR" "$BIN" "$MARKER"
TOKEN='fabric-launch-canary-7e5a3c'

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

! grep -R -F "$TOKEN" "$HOME_DIR" >/dev/null
printf '  ✓ Fabric MCP token is launch-only, fail-soft, and absent from argv/config/output\n'
