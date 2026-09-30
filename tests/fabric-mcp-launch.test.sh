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
cleanup() {
  cd / || true
  rm -rf "$TMP"
}
trap cleanup EXIT
HOME_DIR="$TMP/home"
AGENT_DIR="$HOME_DIR/.coop/agent"
BIN="$TMP/bin"
MARKER="$TMP/marker"
mkdir -p "$AGENT_DIR" "$BIN" "$MARKER"
# A fresh fetch stamp keeps every launch's once-a-day refresh from fetching
# origin into the checkout running the tests (#135).
: > "$AGENT_DIR/.coop-fetch-stamp"
# The launch mint follows the tenant chain (H2b): the contract above the working
# folder, then <COOP_DIR or home>/.coop/config. Keep both in the sandbox so a
# developer's own contract or ~/.coop/config tenant never reaches the az argv
# pins. COOP_TEST_STUB_PATH stops lib/common.sh from putting Homebrew's bin
# (a real az, python3 and pi) ahead of the fixture commands on a Mac.
export COOP_DIR="$HOME_DIR"
export COOP_TEST_STUB_PATH="$BIN"
cd "$HOME_DIR"
if [ "${OS:-}" = Windows_NT ]; then
  COOP_TEST_MARKER_NATIVE="$(cygpath -w "$MARKER")"
  export COOP_TEST_MARKER_NATIVE
fi
PY="$(command -v python3 2>/dev/null || command -v python)"
TOKEN="$("$PY" - <<'PY'
import base64, json
part = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode()
print(".".join((part(b'{"alg":"none"}'), part(json.dumps({"tid":"11111111-1111-4111-8111-111111111111","oid":"22222222-2222-4222-8222-222222222222"}, separators=(",", ":")).encode()), part(b"launch-signature"))))
PY
)"
HELPER_DIAGNOSTIC='untrusted-helper-diagnostic-93b75a'
HELPER_TOKENLIKE='tokenlike-helper-value-2309'

"$PY" - "$AGENT_DIR/mcp.json" "$ROOT" <<'PY'
import json, sys
from pathlib import Path
url = "https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint"
target = {key: "" for key in ("workspace_id", "item_id", "item_type", "client", "tenant_id", "environment", "item_name")}
target.update(scope="global", reason="fixture")
config = {
    "mcpServers": {"fabric-sqlendpoint": {
        "url": url,
        "auth": False,
        "requestHeadersCommand": {
            "command": "node",
            "args": [str(Path(sys.argv[2]).resolve() / "lib" / "fabric_request_headers.mjs"), url],
            "timeoutMs": 10000,
        },
        "requestTimeoutMs": 60000,
        "lifecycle": "lazy",
        "_coop_target": target,
    }},
    "_coop": {"schema_version": 1, "managed_servers": ["fabric-sqlendpoint"]},
}
Path(sys.argv[1]).write_text(json.dumps(config), encoding="utf-8")
PY

"$PY" - "$BIN" "$MARKER" "$TOKEN" "${COOP_TEST_MARKER_NATIVE:-}" <<'PY'
import shlex, sys
from pathlib import Path
bin_dir, marker, token, native_marker = sys.argv[1:]
marker = Path(marker)
(Path(bin_dir) / "az").write_text(f'''#!/bin/sh
printf '%s\\n' "$*" > {shlex.quote(str(marker / "az-argv"))}
case "$(cat {shlex.quote(str(marker / "az-mode"))} 2>/dev/null || printf ok)" in
  ok) printf '%s\\n' {shlex.quote('{"accessToken":"' + token + '"}')} ;;
  auth) printf '%s\\n' "ERROR: Please run 'az login' to setup account." >&2; exit 1 ;;
  fail) printf '%s\\n' 'ERROR: token command failed' >&2; exit 2 ;;
esac
''', encoding="ascii")
if native_marker:
    escaped = native_marker.replace("%", "%%")
    (Path(bin_dir) / "az.cmd").write_text(f'''@echo off\r
>"{escaped}\\az-argv" echo %*\r
set /p COOP_TEST_AZ_MODE=<"{escaped}\\az-mode"\r
if "%COOP_TEST_AZ_MODE%"=="auth" (\r
  >&2 echo ERROR: Please run 'az login' to setup account.\r
  exit /b 1\r
)\r
if "%COOP_TEST_AZ_MODE%"=="fail" (\r
  >&2 echo ERROR: token command failed\r
  exit /b 2\r
)\r
echo {{"accessToken":"{token}"}}\r
''', encoding="ascii")
PY
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
  printf '%s' "${COOP_TEST_AZ_MODE:-ok}" > "$MARKER/az-mode"
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

PHASE='tenant-pinned'
# H2b: with a client tenant saved by onboarding, the launch token is minted for
# it; the az argv gains exactly `--tenant <id>` at the end.
rm -f "$MARKER/pi-state"
printf '%s' '{"azure":{"purpose":"client_resources","tenant_id":"cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"}}' > "$HOME_DIR/.coop/config"
out="$(run_coop 2>"$TMP/pinned.err")"
rm -f "$HOME_DIR/.coop/config"
[ -f "$MARKER/pi-state" ]
[ "$out" = "" ]
case "$(cat "$MARKER/az-argv")" in
  'account get-access-token --resource https://api.fabric.microsoft.com --output json --tenant cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd') ;;
  *) echo 'launch token was not minted for the client tenant' >&2; exit 1 ;;
esac

PHASE='auth-failure'
rm -f "$MARKER/pi-state"
# A cached Azure preflight success (.az-ok) is stale once the mint reports
# auth_required: the launch drops it so the next launch checks again (H2).
printf '%s' 'cached-tenant.example' > "$AGENT_DIR/.az-ok"
COOP_TEST_AZ_MODE=auth COOP_TEST_EXPECT_TOKEN=absent \
COOP_FABRIC_MCP_TOKEN='stale-inherited-token' run_coop >"$TMP/fail.out" 2>"$TMP/fail.err"
[ -f "$MARKER/pi-state" ]
grep -F 'Azure authentication is required' "$TMP/fail.err" >/dev/null
[ ! -e "$AGENT_DIR/.az-ok" ]
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

# A failing helper must not block raw Pi or the coop launch. On Windows, real Python
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

# Control bytes and even whitespace-only stderr are contamination. Exercise all
# public POSIX launch paths; each must continue without any bearer.
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

done

! grep -R -F "$TOKEN" "$HOME_DIR" >/dev/null
printf '  ✓ Fabric MCP token is launch-only, fail-soft, and absent from argv/config/output\n'
