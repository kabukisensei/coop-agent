#!/usr/bin/env python3
"""Offline Warehouse MCP target and doctor contract tests."""

import importlib.util
import base64
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
# The token-timeout and SIGTERM process-tree kill cases (POSIX) start real
# children, poll for them and wait fixed seconds, so they run only in the
# extended lane (COOP_TEST_EXTENDED=1, #96).
EXTENDED_LANE = os.environ.get("COOP_TEST_EXTENDED") == "1"
spec = importlib.util.spec_from_file_location(
    "warehouse_mcp", ROOT / "lib" / "warehouse_mcp.py"
)
wmcp = importlib.util.module_from_spec(spec)
sys.modules["warehouse_mcp"] = wmcp
spec.loader.exec_module(wmcp)


def entry(url=wmcp.GLOBAL_SQL_ENDPOINT_URL):
    match = wmcp.re.match(
        rf"^{wmcp.re.escape(wmcp.FABRIC_RESOURCE)}/v1/mcp/dataPlane/workspaces/({wmcp.UUID_RE.pattern[1:-1]})/items/({wmcp.UUID_RE.pattern[1:-1]})/sqlEndpoint$",
        url,
    )
    target = {
        "scope": "item" if match else "global",
        "workspace_id": match.group(1) if match else "",
        "item_id": match.group(2) if match else "",
        "item_type": "Warehouse" if match else "",
        "reason": "fixture",
        "client": "",
        "tenant_id": "",
        "environment": "",
        "item_name": "",
    }
    return {
        "url": url,
        "auth": False,
        "requestHeadersCommand": {
            "command": "node",
            "args": [wmcp.REQUEST_HEADERS_HELPER, url],
            "timeoutMs": 10000,
        },
        "requestTimeoutMs": 60000,
        "lifecycle": "lazy",
        "_coop_target": target,
    }


def managed_config(url=wmcp.GLOBAL_SQL_ENDPOINT_URL):
    return {
        "mcpServers": {"fabric-sqlendpoint": entry(url)},
        "_coop": {"schema_version": 1, "managed_servers": ["fabric-sqlendpoint"]},
    }


# Configuration alone is registered, not healthy; all documented spellings work.
cfg = managed_config()
assert wmcp.doctor_status(cfg)["state"] == "registered"
with mock.patch.object(
    wmcp,
    "az_access_token",
    side_effect=AssertionError("offline status requested credentials"),
) as offline_auth:
    assert wmcp.doctor_status(cfg, [{"name": "executeSQL"}])["state"] == "registered"
    offline_auth.assert_not_called()
assert (
    wmcp.doctor_status({"mcpServers": {"fabric-sqlendpoint": entry()}})["state"]
    == "unavailable"
)
for forbidden in (
    {"command": "npx"},
    {"args": ["mcp-remote"]},
    {"bearerToken": "secret-fixture-token"},
    {"headers": {"Authorization": "Bearer secret-fixture-token"}},
    {"oauth": {"enabled": True}},
    {"bearerTokenEnv": "ANOTHER_SECRET"},
    {"bearerTokenStore": "forged"},
    {"caFile": "forged.pem"},
    {"httpTransport": {"forged": True}},
    {"protocolVersion": "forged"},
    {"unknownExtra": True},
):
    candidate = entry()
    candidate.update(forbidden)
    assert wmcp.sqlendpoint_config_status(candidate) == "unavailable"
for spelling in (
    "executeSQL",
    "execute_query",
    "fabric-sqlendpoint-execute_query",
    "fabric_sqlendpoint_execute_query",
):
    assert wmcp.doctor_status(cfg, [{"name": spelling}])["state"] == "registered"
assert wmcp.doctor_status(cfg, [{"name": "listSchemas"}])["state"] == "tool_missing"
for adversarial in (
    "fabric-sqlendpoint-not_sql",
    "fabric-sqlendpoint-delete_all",
    "fabric-sqlendpoint-execute_query_extra",
    "FABRIC-SQLENDPOINT-execute_query",
):
    assert wmcp.doctor_status(cfg, [{"name": adversarial}])["state"] == "tool_missing"
assert wmcp.doctor_status({}, ["executeSQL"])["state"] == "unavailable"
assert (
    wmcp.sqlendpoint_config_status(entry("https://evil.example/sqlEndpoint"))
    == "target_invalid"
)
assert "secret-regression-token" not in json.dumps(entry())
assert "mcp-remote" not in json.dumps(entry())
assert wmcp.machine_sqlendpoint_enabled({"integrations": {"fabric": False}}) is False
assert (
    wmcp.machine_sqlendpoint_enabled(
        {"integrations": {"fabric": False, "fabric_sql_endpoint": True}}
    )
    is True
)
assert wmcp.machine_sqlendpoint_enabled({"integrations": {}}) is True
for malformed_flag in (None, "false", "true", 0, 1, {}, []):
    assert (
        wmcp.machine_sqlendpoint_enabled(
            {"integrations": {"fabric": False, "fabric_sql_endpoint": malformed_flag}}
        )
        is False
    )
assert (
    wmcp.machine_sqlendpoint_enabled(
        {
            "integrations": {
                "fabric": False,
                "fabric_sql_endpoint": None,
                "fabric-sqlendpoint": True,
            }
        }
    )
    is False
)
assert (
    wmcp.machine_sqlendpoint_enabled(
        {
            "integrations": {
                "fabric": False,
                "fabric_sql_endpoint": True,
                "fabric-sqlendpoint": False,
            }
        }
    )
    is True
)

# Every Python token caller delegates to the one hardened Node token mode. The
# Python boundary admits one exact, capped frame and never launches az/cmd itself.
secret_token = "secret-regression-token"
helper_token = ".".join(
    base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
    for value in (
        b'{"alg":"none"}',
        b'{"tid":"11111111-1111-4111-8111-111111111111","oid":"22222222-2222-4222-8222-222222222222"}',
        b"signature",
    )
)
helper_frame = (
    b"coop-azure-token-v1\t"
    + base64.urlsafe_b64encode(helper_token.encode("ascii")).rstrip(b"=")
    + b"\tend"
)
trusted_node = str(Path(sys.executable).resolve())
for resource in (wmcp.FABRIC_RESOURCE, wmcp.SQL_RESOURCE):
    with (
        mock.patch.object(wmcp, "_native_node", return_value=trusted_node),
        mock.patch.object(
            wmcp, "_run_token_helper", return_value=(0, helper_frame, b"", False)
        ) as run,
    ):
        assert wmcp.az_access_token(resource=resource) == (helper_token, "ok")
        assert run.call_args.args == (
            [trusted_node, wmcp.REQUEST_HEADERS_HELPER, "--token", resource],
            10,
        )

with (
    mock.patch.object(wmcp, "_native_node", return_value=None),
    mock.patch.object(wmcp, "_run_token_helper") as run,
):
    assert wmcp.az_access_token() == ("", "azure_cli_unavailable")
    run.assert_not_called()

with (
    mock.patch.object(wmcp, "_native_node", return_value=trusted_node),
    mock.patch.object(wmcp, "_run_token_helper", side_effect=OSError("no launch")),
):
    assert wmcp.az_access_token() == ("", "token_launch_failed")

for result, expected in (
    ((22, b"", b"", True), "token_timeout"),
    ((20, b"", b"", False), "azure_cli_unavailable"),
    ((21, b"", b"", False), "token_launch_failed"),
    ((23, b"", b"", False), "token_command_failed"),
    ((24, b"", b"", False), "token_output_invalid"),
    ((25, b"", b"", False), "auth_required"),
    ((0, helper_frame, b"diagnostic-canary", False), "token_output_invalid"),
):
    with (
        mock.patch.object(wmcp, "_native_node", return_value=trusted_node),
        mock.patch.object(wmcp, "_run_token_helper", return_value=result),
    ):
        token, state = wmcp.az_access_token()
        assert (token, state) == ("", expected)
        assert helper_token not in state

for malformed in (
    b"",
    b"not-a-frame",
    helper_frame + b"\n",
    helper_frame + helper_frame,
    helper_frame.replace(b"\tend", b"\tend\ttrailing"),
    b"coop-azure-token-v1\t*\tend",
    b"coop-azure-token-v1\t_w\tend",
):
    with (
        mock.patch.object(wmcp, "_native_node", return_value=trusted_node),
        mock.patch.object(
            wmcp, "_run_token_helper", return_value=(0, malformed, b"", False)
        ),
    ):
        assert wmcp.az_access_token() == ("", "token_output_invalid")

with mock.patch.object(wmcp, "_run_token_helper") as run:
    assert wmcp.az_access_token(resource="https://evil.example") == (
        "",
        "token_command_failed",
    )
    run.assert_not_called()

with mock.patch.dict(wmcp.os.environ, {"ARBITRARY_SECRET_CANARY": "must-not-pass"}):
    helper_env = wmcp._token_helper_environment()
assert "ARBITRARY_SECRET_CANARY" not in helper_env
assert set(helper_env) <= {
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "SystemDrive",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "AZURE_CONFIG_DIR",
}

with (
    mock.patch.object(wmcp, "_is_windows", return_value=True),
    mock.patch.dict(
        wmcp.os.environ,
        {
            "PATH": r"C:\\fixture",
            "SYSTEMROOT": r"C:\\Windows",
            "SYSTEMDRIVE": "C:",
            "COOP_FABRIC_MCP_TOKEN": "must-not-pass",
            "NODE_OPTIONS": "--require=untrusted.cjs",
            "PYTHONPATH": "untrusted-python-injection",
        },
        clear=True,
    ),
):
    windows_helper_env = wmcp._token_helper_environment()
assert windows_helper_env == {
    "PATH": r"C:\\fixture",
    "SYSTEMROOT": r"C:\\Windows",
    "SYSTEMDRIVE": "C:",
}

code, stdout, stderr, timed_out = wmcp._run_token_helper(
    [sys.executable, "-c", f"print('x' * {wmcp.MAX_TOKEN_HELPER_OUTPUT + 1})"],
    2,
)
assert code == 24 and len(stdout) > wmcp.MAX_TOKEN_HELPER_OUTPUT
assert stderr == b"" and timed_out is False

if not wmcp._is_windows():
    original_sigterm = signal.getsignal(signal.SIGTERM)

    def prior_sigterm(_signum, _frame):
        return None

    signal.signal(signal.SIGTERM, prior_sigterm)
    try:
        for command in (
            [sys.executable, "-c", "print('ok')"],
            [sys.executable, "-c", "raise SystemExit(7)"],
        ):
            wmcp._run_token_helper(command, 2)
            assert signal.getsignal(signal.SIGTERM) is prior_sigterm
        try:
            wmcp._run_token_helper(["/definitely/missing/token-helper"], 2)
        except OSError:
            pass
        else:
            raise AssertionError("missing token helper unexpectedly launched")
        assert signal.getsignal(signal.SIGTERM) is prior_sigterm

        worker_errors = []

        def run_from_worker():
            try:
                wmcp._run_token_helper([sys.executable, "-c", "print('unsafe')"], 2)
            except OSError:
                worker_errors.append("rejected")

        worker = threading.Thread(target=run_from_worker)
        worker.start()
        worker.join(timeout=3)
        assert worker_errors == ["rejected"]
        assert signal.getsignal(signal.SIGTERM) is prior_sigterm
    finally:
        signal.signal(signal.SIGTERM, original_sigterm)

if not wmcp._is_windows() and not EXTENDED_LANE:
    print(
        "  - skipped in the gate lane: token timeout and SIGTERM kill the whole"
        " az process tree (COOP_TEST_EXTENDED=1 runs it)"
    )
if not wmcp._is_windows() and EXTENDED_LANE:
    with tempfile.TemporaryDirectory() as tree_dir:
        tree = Path(tree_dir)
        fake_az = tree / "az"
        descendant_pid = tree / "descendant.pid"
        delayed_marker = tree / "descendant-survived"
        fake_az.write_text(
            f"""#!{sys.executable}
import subprocess
import sys
import time
subprocess.Popen([
    sys.executable,
    "-c",
    "import os, pathlib, sys, time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(2); pathlib.Path(sys.argv[2]).write_text('survived'); time.sleep(20)",
    {str(descendant_pid)!r},
    {str(delayed_marker)!r},
])
while True:
    time.sleep(1)
""",
            encoding="utf-8",
        )
        fake_az.chmod(0o755)
        with mock.patch.dict(
            wmcp.os.environ,
            {"PATH": f"{tree}{os.pathsep}{os.environ.get('PATH', '')}"},
        ):
            assert wmcp.az_access_token(timeout=1) == ("", "token_timeout")
        deadline = time.monotonic() + 2
        while not descendant_pid.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert descendant_pid.exists(), "fake az descendant never started"
        pid = int(descendant_pid.read_text(encoding="utf-8"))

        def process_exists(candidate: int) -> bool:
            try:
                os.kill(candidate, 0)
                return True
            except ProcessLookupError:
                return False

        deadline = time.monotonic() + 2
        while process_exists(pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not process_exists(pid), "Azure CLI descendant survived timeout"
        time.sleep(2.2)
        assert not delayed_marker.exists(), "killed descendant wrote delayed marker"

    with tempfile.TemporaryDirectory() as signal_dir:
        tree = Path(signal_dir)
        fake_az = tree / "az"
        runner = tree / "runner.py"
        node_pid = tree / "node.pid"
        az_pid = tree / "az.pid"
        descendant_pid = tree / "descendant.pid"
        delayed_marker = tree / "descendant-survived"
        fake_az.write_text(
            f"""#!{sys.executable}
import os
import pathlib
import subprocess
import sys
import time
pathlib.Path({str(node_pid)!r}).write_text(str(os.getppid()))
pathlib.Path({str(az_pid)!r}).write_text(str(os.getpid()))
subprocess.Popen([
    sys.executable,
    "-c",
    "import os, pathlib, sys, time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(2); pathlib.Path(sys.argv[2]).write_text('survived'); time.sleep(20)",
    {str(descendant_pid)!r},
    {str(delayed_marker)!r},
])
while True:
    time.sleep(1)
""",
            encoding="utf-8",
        )
        fake_az.chmod(0o755)
        runner.write_text(
            f"""import importlib.util
import sys
spec = importlib.util.spec_from_file_location('warehouse_mcp', {str(ROOT / "lib" / "warehouse_mcp.py")!r})
module = importlib.util.module_from_spec(spec)
sys.modules['warehouse_mcp'] = module
spec.loader.exec_module(module)
module.az_access_token(timeout=30)
""",
            encoding="utf-8",
        )
        signal_env = dict(os.environ)
        signal_env["PATH"] = f"{tree}{os.pathsep}{signal_env.get('PATH', '')}"
        outer = subprocess.Popen(
            [sys.executable, str(runner)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=signal_env,
        )
        deadline = time.monotonic() + 4
        while (
            not all(path.exists() for path in (node_pid, az_pid, descendant_pid))
            and time.monotonic() < deadline
        ):
            time.sleep(0.02)
        assert all(path.exists() for path in (node_pid, az_pid, descendant_pid))
        process_ids = [
            int(path.read_text(encoding="utf-8"))
            for path in (node_pid, az_pid, descendant_pid)
        ]
        outer.send_signal(signal.SIGTERM)
        assert outer.wait(timeout=5) == -signal.SIGTERM
        deadline = time.monotonic() + 3
        while (
            any(process_exists(pid) for pid in process_ids)
            and time.monotonic() < deadline
        ):
            time.sleep(0.02)
        assert not any(process_exists(pid) for pid in process_ids), (
            "Node/Azure process tree survived outer Python SIGTERM"
        )
        time.sleep(2.2)
        assert not delayed_marker.exists(), "SIGTERM-surviving descendant wrote marker"

fake_proc = mock.Mock(pid=4242)
with (
    mock.patch.object(wmcp, "_is_windows", return_value=True),
    mock.patch.object(
        wmcp,
        "_windows_taskkill_command",
        return_value=[r"C:\Windows\System32\taskkill.exe", "/PID", "4242", "/T", "/F"],
    ),
    mock.patch.object(wmcp.subprocess, "run") as taskkill_run,
):
    wmcp._terminate_token_helper_tree(fake_proc)
taskkill_run.assert_called_once()
assert taskkill_run.call_args.args[0][0] == r"C:\Windows\System32\taskkill.exe"
assert taskkill_run.call_args.kwargs["env"] == {"SystemRoot": r"C:\Windows"}
assert taskkill_run.call_args.kwargs["shell"] is False
fake_proc.kill.assert_called_once()

with tempfile.TemporaryDirectory(dir=ROOT) as local_dir:
    local_node = Path(local_dir) / ("node.exe" if wmcp._is_windows() else "node")
    local_node.write_bytes(b"local-node-hijack")
    local_node.chmod(0o755)
    with mock.patch.object(wmcp.shutil, "which", return_value=str(local_node)):
        assert wmcp._native_node() is None


# Exact item scope requires complete UUIDs and canonicalizes them; mismatch fails.
workspace = "11111111-1111-1111-1111-111111111111"
item = "22222222-2222-2222-2222-222222222222"
item_url = f"{wmcp.FABRIC_RESOURCE}/v1/mcp/dataPlane/workspaces/{workspace}/items/{item}/sqlEndpoint"
project = {
    "fabric": {
        "default_workspace_id": workspace.upper(),
        "default_sql_endpoint": {
            "item_type": "Warehouse",
            "item_name": "Fixture Warehouse",
            "item_id": item.upper(),
        },
    }
}
target = wmcp.select_target(project)
assert target.scope == "item" and target.url == item_url
lakehouse_project = {
    "fabric": {
        "default_workspace_id": workspace,
        "default_sql_endpoint": {
            "item_type": "Lakehouse",
            "item_name": "Fixture Lakehouse",
            "item_id": item,
            "sqlEndpointProperties": {"id": "33333333-3333-3333-3333-333333333333"},
        },
    }
}
lakehouse_target = wmcp.select_target(lakehouse_project)
assert lakehouse_target.scope == "item"
assert "/items/33333333-3333-3333-3333-333333333333/sqlEndpoint" in lakehouse_target.url
assert (
    wmcp.select_target({"fabric": {"default_workspace_id": workspace}}).scope
    == "global"
)
for malformed in (
    {"default_sql_endpoint": {}},
    {"default_sql_endpoint": {"item_type": "Warehouse", "item_id": item}},
    {
        "default_workspace_id": "not-a-uuid",
        "default_sql_endpoint": {"item_type": "Warehouse", "item_id": item},
    },
    {
        "default_workspace_id": workspace,
        "default_sql_endpoint": {"item_type": "Lakehouse", "item_id": item},
    },
    {
        "default_workspace_id": workspace,
        "default_sql_endpoint": {"item_type": "Notebook", "item_id": item},
    },
):
    malformed_project = {"fabric": malformed}
    invalid = wmcp.select_target(malformed_project)
    assert invalid.scope == "invalid" and invalid.url == ""
    assert (
        wmcp.doctor_status({}, project=malformed_project)["state"] == "target_invalid"
    )
wrong_cfg = managed_config(
    item_url.replace(item, "33333333-3333-3333-3333-333333333333")
)
assert (
    wmcp.doctor_status(wrong_cfg, [{"name": "executeSQL"}], project=project)["state"]
    == "target_invalid"
)

# Probe consumes the Windows-wrapper token and continues to tools/list without
# exposing it. The remaining seams cover item metadata and downstream states.
probe_calls = []


def fake_global_list(url, token, timeout=8):
    probe_calls.append((url, token, timeout))
    return ([{"name": "executeSQL"}], "ok")


with (
    mock.patch.object(wmcp, "_native_node", return_value=trusted_node),
    mock.patch.object(
        wmcp, "_run_token_helper", return_value=(0, helper_frame, b"", False)
    ),
    mock.patch.object(wmcp, "mcp_tools_list", side_effect=fake_global_list),
):
    windows_probed = wmcp.doctor_status(cfg, project={}, probe=True)
assert windows_probed["state"] == "registered"
assert probe_calls == [(wmcp.GLOBAL_SQL_ENDPOINT_URL, helper_token, 8)]
assert helper_token not in json.dumps(windows_probed)

original_az, original_get, original_list = (
    wmcp.az_access_token,
    wmcp.fabric_get_json,
    wmcp.mcp_tools_list,
)
calls = []
try:
    wmcp.az_access_token = lambda timeout=8: ("secret-fixture-token", "ok")

    def fake_get(url, token, timeout=8):
        calls.append(("rest", url, token))
        return ({"type": "Warehouse"}, "ok")

    def fake_list(url, token, timeout=8):
        calls.append(("tools", url, token))
        return ([{"name": "executeSQL"}], "ok")

    wmcp.fabric_get_json = fake_get
    wmcp.mcp_tools_list = fake_list
    probed = wmcp.doctor_status(
        managed_config(item_url),
        project=project,
        probe=True,
    )
    assert probed["state"] == "registered"
    assert [c[0] for c in calls] == ["rest", "tools"]
    assert all(c[2] == "secret-fixture-token" for c in calls)

    calls.clear()

    def fake_lakehouse_get(url, token, timeout=8):
        calls.append(("rest", url, token))
        return (
            {
                "type": "Lakehouse",
                "properties": {
                    "sqlEndpointProperties": {
                        "id": "33333333-3333-3333-3333-333333333333"
                    }
                },
            },
            "ok",
        )

    setattr(wmcp, "fabric_get_json", fake_lakehouse_get)
    lakehouse_probed = wmcp.doctor_status(
        managed_config(lakehouse_target.url),
        project=lakehouse_project,
        probe=True,
    )
    assert lakehouse_probed["state"] == "registered"
    assert calls[0][1].endswith(f"/items/{item}")

    wmcp.az_access_token = lambda timeout=8: ("", "auth_required")
    assert wmcp.doctor_status(cfg, project={}, probe=True)["state"] == "auth_required"

    wmcp.az_access_token = lambda timeout=8: ("secret-fixture-token", "ok")
    wmcp.fabric_get_json = lambda url, token, timeout=8: ({}, "target_invalid")
    assert (
        wmcp.doctor_status(
            managed_config(item_url),
            project=project,
            probe=True,
        )["state"]
        == "target_invalid"
    )

    wmcp.fabric_get_json = fake_get
    wmcp.mcp_tools_list = lambda url, token, timeout=8: (
        [{"name": "listSchemas"}],
        "ok",
    )
    assert (
        wmcp.doctor_status(
            managed_config(item_url),
            project=project,
            probe=True,
        )["state"]
        == "tool_missing"
    )

    wmcp.mcp_tools_list = lambda url, token, timeout=8: ([], "unavailable")
    assert wmcp.doctor_status(cfg, project={}, probe=True)["state"] == "unavailable"
finally:
    wmcp.az_access_token, wmcp.fabric_get_json, wmcp.mcp_tools_list = (
        original_az,
        original_get,
        original_list,
    )


# Direct streamable-HTTP parser: initialize JSON, real empty 202 notification,
# then tools/list JSON. Request calls still reject empty or malformed bodies.
class FakeResponse:
    def __init__(self, body, status=200, session="session-1"):
        self.body = body
        self.status = status
        self.headers = {"Mcp-Session-Id": session}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.body

    def getcode(self):
        return self.status


original_http_open = wmcp._http_open
try:
    responses = iter(
        [
            FakeResponse(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {"protocolVersion": wmcp.MCP_PROTOCOL_VERSION},
                    }
                ).encode()
            ),
            FakeResponse(b"", status=202),
            FakeResponse(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 2,
                        "result": {"tools": [{"name": "execute_query"}]},
                    }
                ).encode()
            ),
        ]
    )
    requests = []
    authorization_headers = []

    def fake_http_open(request, *_args, **_kwargs):
        requests.append(json.loads(request.data))
        authorization_headers.append(request.get_header("Authorization"))
        return next(responses)

    wmcp._http_open = fake_http_open
    tools, state = wmcp.mcp_tools_list(
        wmcp.GLOBAL_SQL_ENDPOINT_URL, secret_token, timeout=1
    )
    assert state == "ok" and wmcp.classify_tools(tools) == "registered"
    assert [request["method"] for request in requests] == [
        "initialize",
        "notifications/initialized",
        "tools/list",
    ]
    assert secret_token not in json.dumps(requests)
    assert authorization_headers == [f"Bearer {secret_token}"] * 3

    for body, status in ((b"", 200), (b"", 204), (b"not-json", 200)):
        wmcp._http_open = lambda *_a, **_k: FakeResponse(body, status=status)
        _, request_state, _ = wmcp._mcp_post(
            wmcp.GLOBAL_SQL_ENDPOINT_URL,
            "secret-fixture-token",
            {"jsonrpc": "2.0", "id": 9, "method": "tools/list"},
            timeout=1,
        )
        assert request_state == "unavailable"

    wmcp._http_open = lambda *_a, **_k: FakeResponse(
        b'{"jsonrpc":"2.0","id":10,"result":{"tools":[]}}'
    )
    _, mismatched_state, _ = wmcp._mcp_post(
        wmcp.GLOBAL_SQL_ENDPOINT_URL,
        "secret-fixture-token",
        {"jsonrpc": "2.0", "id": 9, "method": "tools/list"},
        timeout=1,
    )
    assert mismatched_state == "unavailable"

    for status in (202, 204):
        wmcp._http_open = lambda *_a, **_k: FakeResponse(b"", status=status)
        _, notification_state, _ = wmcp._mcp_post(
            wmcp.GLOBAL_SQL_ENDPOINT_URL,
            "secret-fixture-token",
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            timeout=1,
            allow_empty_notification=True,
        )
        assert notification_state == "ok"
finally:
    wmcp._http_open = original_http_open

assert (
    wmcp._RejectRedirects().redirect_request(
        None, None, 302, "Found", {}, "https://evil.example"
    )
    is None
)

# Both Doctor front ends map token-acquisition states to the same specific,
# non-secret guidance, and only a proven auth failure tells the user to sign in.
doctor_hints = {
    "azure_cli_unavailable": "install/repair Azure CLI and ensure az is on PATH; this is not an authentication diagnosis",
    "token_launch_failed": "Azure CLI was found but could not be launched; this is not an authentication diagnosis",
    "token_timeout": "Azure CLI token command exceeded the bounded timeout; retry after checking Azure CLI responsiveness",
    "token_command_failed": "Azure CLI launched but token acquisition failed; run: az account get-access-token --resource https://api.fabric.microsoft.com --output json",
    "token_output_invalid": "Azure CLI returned no usable accessToken JSON; verify the Fabric token command output",
    "auth_required": "sign in with Azure CLI/tenant access; doctor never triggers login",
}
for doctor_script in (ROOT / "scripts" / "doctor.ps1",):
    doctor_text = doctor_script.read_text(encoding="utf-8-sig")
    for diagnostic_state, expected_hint in doctor_hints.items():
        matching_lines = [
            line
            for line in doctor_text.splitlines()
            if diagnostic_state in line and "fabric-sqlendpoint" in line
        ]
        assert len(matching_lines) == 1
        assert expected_hint in matching_lines[0]
        if diagnostic_state != "auth_required":
            assert "sign in" not in matching_lines[0].lower()
        if diagnostic_state == "token_command_failed":
            # H2b: the token command hint appends the probe tenant (--tenant).
            flag = matching_lines[0].split(expected_hint, 1)[1].split('"', 1)[0]
            assert "tenant" in flag.lower(), (doctor_script, matching_lines[0])
    # H2b: the fabric row states that coop cannot pin the fabric MCP's tenant.
    assert any(
        "server configured (uses az's default account; coop cannot pin its tenant)"
        in line
        for line in doctor_text.splitlines()
    ), doctor_script
    assert secret_token not in doctor_text

print(
    "  OK  Warehouse MCP doctor is token-safe, bounded-by-contract, tool-aware, and target-aware"
)

# --- Client Azure tenant chain (H2): one resolver for launch, doctor and minting.
GUID_A = "11111111-1111-4111-8111-111111111111"
GUID_B = "22222222-2222-4222-8222-222222222222"
config_tenant = {"azure": {"purpose": "client_resources", "tenant_id": GUID_B}}
for project, config, expected in (
    ({"fabric": {"tenant_id": GUID_A}}, config_tenant, ("ok", GUID_A)),
    ({"fabric": {"tenant_id": f"  {GUID_A.upper()} "}}, {}, ("ok", GUID_A.upper())),
    ({"fabric": {"tenant_id": "TODO: tenant id"}}, config_tenant, ("ok", GUID_B)),
    ({"fabric": {"tenant_id": "todo"}}, config_tenant, ("ok", GUID_B)),
    ({"fabric": {"tenant_id": ""}}, config_tenant, ("ok", GUID_B)),
    ({"fabric": {"tenant_id": None}}, config_tenant, ("ok", GUID_B)),
    ({}, config_tenant, ("ok", GUID_B)),
    ({}, {"azure": {"tenant_id": GUID_B}}, ("ok", GUID_B)),
    ({}, {"azure": {"purpose": "internal", "tenant_id": GUID_B}}, ("unset", "")),
    ({}, {"azure": {"purpose": "client_resources", "tenant_id": "TODO"}}, ("unset", "")),
    ({}, {}, ("unset", "")),
    ({}, [], ("unset", "")),
    ({"fabric": {"tenant_id": "contoso.onmicrosoft.com"}}, {}, ("ok", "contoso.onmicrosoft.com")),
    ({}, {"azure": {"tenant_id": "tenant-aaa.example"}}, ("ok", "tenant-aaa.example")),
    # Invalid project values stop the chain; the config tenant is never used.
    ({"fabric": {"tenant_id": "x&calc"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": "a b"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": 'x"y'}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": "TBD"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": "none"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": "tenant-aaa"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": ".example"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": "a..example"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": "-a.example"}}, config_tenant, ("invalid", "")),
    ({"fabric": {"tenant_id": GUID_A + "\n"}}, {}, ("ok", GUID_A)),
    ({}, {"azure": {"tenant_id": "changeme"}}, ("invalid", "")),
):
    got = wmcp.tenant_from_sources(project, config)
    assert got == expected, (project, config, got, expected)

# The `tenant` subcommand: real files, the real project walker, COOP_DIR, a BOM,
# malformed JSON, exit codes 0/1/2, nothing on stderr, a rejected value never echoed.
with tempfile.TemporaryDirectory() as tmp:
    tmp_path = Path(tmp)
    coop_dir = tmp_path / "coop"
    (coop_dir / ".coop").mkdir(parents=True)
    work = tmp_path / "work" / "nested"
    work.mkdir(parents=True)
    (tmp_path / "work" / ".coop").mkdir()
    contract = tmp_path / "work" / ".coop" / "project.yml"
    config_file = coop_dir / ".coop" / "config"
    env = {**os.environ, "COOP_DIR": str(coop_dir)}

    def tenant_cli(*extra, cwd=work):
        result = subprocess.run(
            [sys.executable, str(ROOT / "lib" / "warehouse_mcp.py"), "tenant", *extra],
            cwd=cwd, env=env, capture_output=True, text=True, timeout=30,
        )
        assert result.stderr == "", result.stderr
        return result.returncode, result.stdout.strip()

    assert tenant_cli() == (1, "")
    config_file.write_bytes(b"\xef\xbb\xbf" + json.dumps({"azure": {"tenant_id": GUID_B}}).encode())
    assert tenant_cli() == (0, GUID_B)
    contract.write_text('fabric:\n  tenant_id: "TODO: tenant id"\n', encoding="utf-8")
    assert tenant_cli() == (0, GUID_B)
    contract.write_text(f"fabric:\n  tenant_id: {GUID_A}\n", encoding="utf-8")
    assert tenant_cli() == (0, GUID_A)
    contract.write_text("fabric:\n  tenant_id: 'x&calc'\n", encoding="utf-8")
    assert tenant_cli() == (2, "")
    # --project: the contract the launcher found (its walk reaches the root and
    # falls back to the bundled contract); empty means it found none.
    contract.write_text(f"fabric:\n  tenant_id: {GUID_A}\n", encoding="utf-8")
    assert tenant_cli(f"--project={contract}", cwd=tmp_path) == (0, GUID_A)
    assert tenant_cli("--project=") == (0, GUID_B)
    deep = work / "a" / "b" / "c" / "d" / "e" / "f" / "g"
    deep.mkdir(parents=True)
    assert tenant_cli(f"--project={contract}", cwd=deep) == (0, GUID_A)
    contract.unlink()
    config_file.write_text("{not json", encoding="utf-8")
    assert tenant_cli() == (1, "")
    config_file.write_text(json.dumps({"azure": {"purpose": "internal", "tenant_id": GUID_B}}), encoding="utf-8")
    assert tenant_cli() == (1, "")

print(
    "  OK  tenant chain: contract, then ~/.coop/config (client resources only), GUID or dotted domain; invalid stops the chain"
)

# --- H2b: coop's own mints are pinned to the client tenant --------------------
# The shared fake az (tests/fixtures/fake-az.mjs) mints for --tenant, or without
# it for its default account: here a guest's home tenant, which is the wrong one.
HOME_TENANT = "abababab-abab-4bab-8bab-abababababab"
CLIENT_TENANT = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
FABRIC_ARGV = "account get-access-token --resource https://api.fabric.microsoft.com --output json"

# The argv seam: a tenant appends --tenant; none keeps the argv; a bad one fails closed.
for pinned in (CLIENT_TENANT, "contoso.onmicrosoft.com"):
    with (
        mock.patch.object(wmcp, "_native_node", return_value=trusted_node),
        mock.patch.object(
            wmcp, "_run_token_helper", return_value=(0, helper_frame, b"", False)
        ) as run,
    ):
        assert wmcp.az_access_token(tenant=pinned) == (helper_token, "ok")
        assert run.call_args.args == (
            [trusted_node, wmcp.REQUEST_HEADERS_HELPER, "--token", wmcp.FABRIC_RESOURCE, "--tenant", pinned],
            10,
        )
with (
    mock.patch.object(wmcp, "_native_node", return_value=trusted_node),
    mock.patch.object(
        wmcp, "_run_token_helper", side_effect=AssertionError("a bad tenant reached the token helper")
    ),
):
    for bad in ("x&calc", "tenant-aaa", "TODO", " " + CLIENT_TENANT, CLIENT_TENANT + "\n"):
        assert wmcp.az_access_token(tenant=bad) == ("", "token_command_failed"), bad


def tid_of(token: str) -> str:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["tid"]


def fake_az_bin(tmp: Path) -> tuple[Path, Path]:
    """A PATH folder whose az is the shared fake; returns (bin, state)."""
    state = tmp / "az-state"
    bin_dir = tmp / "az-bin"
    state.mkdir()
    bin_dir.mkdir()
    (state / "tokens").write_text(f"{HOME_TENANT} *\n{CLIENT_TENANT} *\n", encoding="ascii")
    (state / "default-tenant").write_text(HOME_TENANT, encoding="ascii")
    node = str(Path(shutil.which("node")).resolve())
    fake = str(ROOT / "tests" / "fixtures" / "fake-az.mjs")
    # The token helper hands az an allowlisted environment: the wrapper names the state.
    if os.name == "nt":
        (bin_dir / "az.cmd").write_bytes(
            f'@echo off\r\nset "COOP_TEST_AZ_STATE={state}"\r\n"{node}" "{fake}" %*\r\nexit /b %ERRORLEVEL%\r\n'.encode("ascii")
        )
    else:
        wrapper = bin_dir / "az"
        wrapper.write_text(
            f"#!/bin/sh\nCOOP_TEST_AZ_STATE={shlex.quote(str(state))} exec {shlex.quote(node)} {shlex.quote(fake)} \"$@\"\n",
            encoding="ascii",
        )
        wrapper.chmod(0o755)
    return bin_dir, state


def az_calls(state: Path) -> list[str]:
    log = state / "argv.log"
    return log.read_text(encoding="utf-8").splitlines() if log.exists() else []


with tempfile.TemporaryDirectory() as tmp:
    tmp_path = Path(tmp)
    bin_dir, az_state = fake_az_bin(tmp_path)
    coop_dir = tmp_path / "coop"
    (coop_dir / ".coop").mkdir(parents=True)
    config_file = coop_dir / ".coop" / "config"
    repo = tmp_path / "repo"
    deep = repo / "a" / "b" / "c" / "d" / "e" / "f" / "g" / "h" / "i"
    deep.mkdir(parents=True)
    mcp_path = tmp_path / "mcp.json"
    mcp_path.write_text(json.dumps(managed_config()), encoding="utf-8")
    env = {
        **os.environ,
        "COOP_DIR": str(coop_dir),
        "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
    }

    def launch_token(cwd=repo):
        result = subprocess.run(
            [sys.executable, str(ROOT / "lib" / "warehouse_mcp.py"), "launch-token", str(mcp_path)],
            cwd=cwd, env=env, capture_output=True, timeout=60,
        )
        assert result.returncode == 0 and result.stderr == b"", result
        frame = result.stdout.decode("ascii")
        assert frame.startswith("token\t") and frame.endswith("\tend"), frame
        return tid_of(frame[len("token\t") : -len("\tend")])

    # No tenant configured: the az argv is exactly today's, and az's default account answers.
    assert launch_token() == HOME_TENANT
    assert az_calls(az_state) == [FABRIC_ARGV]
    # The onboarding config's tenant pins the launch mint.
    config_file.write_text(json.dumps({"azure": {"purpose": "client_resources", "tenant_id": CLIENT_TENANT}}), encoding="utf-8")
    assert launch_token() == CLIENT_TENANT
    assert az_calls(az_state)[-1] == f"{FABRIC_ARGV} --tenant {CLIENT_TENANT}"
    # The contract beats the config, found the way the launcher finds it: even
    # from nine folders down, where find_project_yml stops looking.
    config_file.write_text(json.dumps({"azure": {"tenant_id": HOME_TENANT}}), encoding="utf-8")
    (repo / ".coop").mkdir()
    (repo / ".coop" / "project.yml").write_text(f"fabric:\n  tenant_id: {CLIENT_TENANT}\n", encoding="utf-8")
    assert wmcp.find_project_yml(deep) is None
    assert launch_token(cwd=deep) == CLIENT_TENANT
    assert az_calls(az_state)[-1] == f"{FABRIC_ARGV} --tenant {CLIENT_TENANT}"
    # An invalid contract tenant is reported by the preflight and doctor; the mint stays unpinned.
    (repo / ".coop" / "project.yml").write_text("fabric:\n  tenant_id: tenant-aaa\n", encoding="utf-8")
    assert launch_token() == HOME_TENANT
    assert az_calls(az_state)[-1] == FABRIC_ARGV

    # SQ2: no managed Warehouse server at all (an Azure SQL-only install). With a
    # contract whose default sql_targets entry names its host, the launcher mints
    # the SQL audience for the same tenant chain; without one it stays silent.
    unmanaged_path = tmp_path / "mcp-unmanaged.json"
    unmanaged_path.write_text(json.dumps({"mcpServers": {}, "_coop": {"managed_servers": []}}), encoding="utf-8")
    SQL_ARGV = "account get-access-token --resource https://database.windows.net/ --output json"

    def launch_token_raw(path):
        result = subprocess.run(
            [sys.executable, str(ROOT / "lib" / "warehouse_mcp.py"), "launch-token", str(path)],
            cwd=repo, env=env, capture_output=True, timeout=60,
        )
        assert result.returncode == 0 and result.stderr == b"", result
        return result.stdout.decode("ascii")

    (repo / ".coop" / "project.yml").write_text(f"fabric:\n  tenant_id: {CLIENT_TENANT}\n", encoding="utf-8")
    assert launch_token_raw(unmanaged_path) == ""
    (repo / ".coop" / "project.yml").write_text(
        f"fabric:\n  tenant_id: {CLIENT_TENANT}\n"
        "sql_targets:\n  default_environment: dev\n  dev:\n    kind: azure_sql\n    server: contoso-dev.database.windows.net\n    database: ContosoDW\n",
        encoding="utf-8",
    )
    frame = launch_token_raw(unmanaged_path)
    assert frame.startswith("token\t") and frame.endswith("\tend"), frame
    assert tid_of(frame[len("token\t") : -len("\tend")]) == CLIENT_TENANT
    assert az_calls(az_state)[-1] == f"{SQL_ARGV} --tenant {CLIENT_TENANT}"
    # A discovered kind (Fabric Warehouse by ids) is the managed server's job, not this path's.
    (repo / ".coop" / "project.yml").write_text(
        f"fabric:\n  tenant_id: {CLIENT_TENANT}\n"
        f"sql_targets:\n  default_environment: dev\n  dev:\n    kind: fabric_warehouse\n    workspace_id: {CLIENT_TENANT}\n    item_id: {HOME_TENANT}\n    database: W\n",
        encoding="utf-8",
    )
    assert launch_token_raw(unmanaged_path) == ""

    # doctor-json reports the tenant it mints for, from the same contract and chain.
    def doctor_json(*extra):
        result = subprocess.run(
            [sys.executable, str(ROOT / "lib" / "warehouse_mcp.py"), "doctor-json", str(mcp_path), *extra],
            cwd=repo, env=env, capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0 and result.stderr == "", result
        return json.loads(result.stdout)["tenant"]

    (repo / ".coop" / "project.yml").write_text(f"fabric:\n  tenant_id: {CLIENT_TENANT}\n", encoding="utf-8")
    assert doctor_json("--project", str(repo / ".coop" / "project.yml")) == CLIENT_TENANT
    assert doctor_json() == HOME_TENANT  # no contract passed: the config tenant
    config_file.unlink()
    assert doctor_json() == ""

    # The doctor probe mints for the tenant it is given, through the real helper.
    probe_tokens = []

    def capture_list(url, token, timeout=8):
        probe_tokens.append(token)
        return ([{"name": "executeSQL"}], "ok")

    previous_cwd = os.getcwd()
    os.chdir(ROOT)  # the helper refuses an az inside its working folder
    try:
        with (
            mock.patch.dict(os.environ, {"PATH": env["PATH"]}),
            mock.patch.object(wmcp, "mcp_tools_list", side_effect=capture_list),
        ):
            pinned_probe = wmcp.doctor_status(cfg, project={}, probe=True, tenant=CLIENT_TENANT)
            unpinned_probe = wmcp.doctor_status(cfg, project={}, probe=True)
    finally:
        os.chdir(previous_cwd)
    assert pinned_probe["state"] == unpinned_probe["state"] == "registered"
    assert (pinned_probe["tenant"], unpinned_probe["tenant"]) == (CLIENT_TENANT, "")
    assert [tid_of(token) for token in probe_tokens] == [CLIENT_TENANT, HOME_TENANT]
    assert az_calls(az_state)[-2:] == [f"{FABRIC_ARGV} --tenant {CLIENT_TENANT}", FABRIC_ARGV]
    for token in probe_tokens:
        assert token not in json.dumps(pinned_probe) + json.dumps(unpinned_probe)

print(
    "  OK  launch token and doctor probe mint for the client tenant; no tenant keeps the az argv unchanged"
)

# --- S4: one copy each of the token/MCP predicates (issue #224) ---------------
# 1. The launch-frame validator (lib/fabric_token_runner.mjs) accepts exactly the
#    warning states `launch-token` can print: WARNING_STATES is the one list.
runner_text = (ROOT / "lib" / "fabric_token_runner.mjs").read_text(encoding="utf-8")
runner_enum = wmcp.re.search(r"\^warning\\t\(([a-z_|]+)\)\\tend\$", runner_text)
assert runner_enum, "runner warning frame regex not found"
assert tuple(runner_enum.group(1).split("|")) == wmcp.WARNING_STATES
assert "config_invalid" in wmcp.WARNING_STATES
# Every state az_access_token can return is in the list (the token helper's exit
# codes map onto it), so the runner never rejects a real warning.
assert {
    "azure_cli_unavailable",
    "token_launch_failed",
    "token_timeout",
    "token_output_invalid",
    "auth_required",
    "token_command_failed",
} <= set(wmcp.WARNING_STATES)

# 2. The PowerShell preflight's auth-failure markers equal the Node helper's.
common_text = (ROOT / "lib" / "common.ps1").read_text(encoding="utf-8-sig")
ps_block = wmcp.re.search(
    r"\$script:CoopAzAuthMarkers = @\((.*?)\)\n", common_text, wmcp.re.S
)
assert ps_block, "Test-CoopAzAuthError marker list not found"
ps_markers = wmcp.re.findall(r"'([^']+)'", ps_block.group(1))
headers_text = (ROOT / "lib" / "fabric_request_headers.mjs").read_text(encoding="utf-8")
mjs_block = wmcp.re.search(r"return \[(\"[^\]]+)\]\.some\(\(marker\)", headers_text)
assert mjs_block, "fabric_request_headers.mjs authError marker list not found"
mjs_markers = wmcp.re.findall(r'"([^"]+)"', mjs_block.group(1))
assert ps_markers == mjs_markers and len(ps_markers) == 12, (ps_markers, mjs_markers)

# 3. managed_sqlendpoint_entry is the one ownership rule.
assert wmcp.managed_sqlendpoint_entry(managed_config()) == entry()
assert wmcp.managed_sqlendpoint_entry({"mcpServers": {"fabric-sqlendpoint": entry()}}) is None
assert (
    wmcp.managed_sqlendpoint_entry(
        {"mcpServers": {}, "_coop": {"managed_servers": ["fabric-sqlendpoint"]}}
    )
    is None
)
assert wmcp.managed_sqlendpoint_entry({"_coop": {"managed_servers": "fabric-sqlendpoint"}}) is None
assert wmcp.managed_sqlendpoint_entry(None) is None
assert wmcp.managed_sqlendpoint_entry([]) is None

# 4. select_target is project_target; the item-URL regex is one compiled object.
assert wmcp.select_target is wmcp.project_target
assert wmcp.ITEM_URL_RE.match(entry(item_url)["url"]).group(2) == item
assert wmcp.ITEM_URL_RE.match(wmcp.GLOBAL_SQL_ENDPOINT_URL) is None
assert wmcp.registered_target(entry(item_url)).item_id == item

# 5. The integrations flag rule: only the boolean true opts in.
assert wmcp.integration_enabled({"integrations": {"fabric": True}}, "fabric") is True
assert wmcp.integration_enabled({"integrations": {"fabric": "true"}}, "fabric") is False
assert wmcp.integration_enabled({"integrations": {"fabric": 1}}, "fabric") is False
assert wmcp.integration_enabled({"integrations": {}}, "fabric") is True
assert wmcp.integration_enabled({"integrations": {}}, "fabric", default=False) is False
assert wmcp.integration_enabled({"integrations": "x"}, "fabric") is True
assert wmcp.integration_enabled(None, "fabric") is True

# 6. jwt_identity mirrors fabric_request_headers.mjs jwtIdentity: canonical
#    base64url, visible ASCII, size cap, oid before sub, lowercased claims.
TID = "11111111-1111-4111-8111-111111111111"


def seg(value) -> str:
    raw = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def token_of(claims, header=None, signature=b"sig") -> str:
    return ".".join((seg(header or {"alg": "none"}), seg(claims), seg(signature)))


assert wmcp.jwt_identity(token_of({"tid": TID.upper(), "oid": "ABC-Def"})) == (TID, "oid", "abc-def")
assert wmcp.jwt_identity(token_of({"tid": TID, "sub": "User@Example"})) == (TID, "sub", "user@example")
assert wmcp.jwt_identity(token_of({"tid": TID, "oid": "o", "sub": "s"})) == (TID, "oid", "o")
for bad in (
    None,
    "",
    token_of({"oid": "x"}),  # no tid
    token_of({"tid": "not-a-guid", "oid": "x"}),
    token_of({"tid": TID}),  # no principal
    token_of({"tid": TID, "oid": 7}),  # principal not a string
    token_of({"tid": TID, "oid": ""}),  # principal empty
    token_of({"tid": TID, "oid": "a b"}),  # principal not visible ASCII
    token_of({"tid": TID, "oid": "x"}) + ".extra",  # four segments
    seg({"tid": TID, "oid": "x"}),  # one segment
    "a.b c.d",  # whitespace in the token
    "x" * (wmcp.MAX_JWT_CHARS + 1),
    seg({"alg": "none"}) + "." + seg({"tid": TID, "oid": "x"}) + "=.sig",  # padding
    seg({"alg": "none"}) + "." + seg({"tid": TID, "oid": "x"})[:-1] + "B.sig",  # non-canonical
    seg({"alg": "none"}) + "." + seg(b"[1,2]") + ".sig",  # payload not an object
    seg({"alg": "none"}) + "." + seg(b"\xff\xfe") + ".sig",  # payload not UTF-8
    seg({"alg": "none"}) + "..sig",  # empty segment
):
    assert wmcp.jwt_identity(bad) is None, bad

# 7. doctor_status is observational and honest: config alone is registered but
#    never usable; the probe's own state is reported separately.
offline = wmcp.doctor_status(cfg)
assert (offline["state"], offline["config_state"], offline["probe_state"], offline["usable"]) == (
    "registered", "registered", "not_probed", False,
)
supplied = wmcp.doctor_status(cfg, [{"name": "executeSQL"}])
assert (supplied["state"], supplied["probe_state"], supplied["usable"]) == ("registered", "not_probed", False)
missing_cfg = wmcp.doctor_status({})
assert (missing_cfg["state"], missing_cfg["config_state"], missing_cfg["probe_state"], missing_cfg["usable"]) == (
    "unavailable", "unavailable", "not_probed", False,
)
bad_target = wmcp.doctor_status({}, project=malformed_project)
assert (bad_target["config_state"], bad_target["probe_state"], bad_target["usable"]) == (
    "target_invalid", "not_probed", False,
)
with (
    mock.patch.object(wmcp, "az_access_token", return_value=("secret-fixture-token", "ok")),
    mock.patch.object(wmcp, "mcp_tools_list", return_value=([{"name": "executeSQL"}], "ok")),
):
    good = wmcp.doctor_status(cfg, project={}, probe=True)
assert (good["state"], good["config_state"], good["probe_state"], good["usable"]) == (
    "registered", "registered", "ok", True,
)
with mock.patch.object(wmcp, "az_access_token", return_value=("", "auth_required")):
    denied = wmcp.doctor_status(cfg, project={}, probe=True)
assert (denied["state"], denied["config_state"], denied["probe_state"], denied["usable"]) == (
    "auth_required", "registered", "auth_required", False,
)
with (
    mock.patch.object(wmcp, "az_access_token", return_value=("secret-fixture-token", "ok")),
    mock.patch.object(wmcp, "mcp_tools_list", return_value=([{"name": "listSchemas"}], "ok")),
):
    no_tool = wmcp.doctor_status(cfg, project={}, probe=True)
assert (no_tool["state"], no_tool["probe_state"], no_tool["usable"]) == ("tool_missing", "tool_missing", False)
# A probe is never attempted when the config alone already fails.
with mock.patch.object(wmcp, "az_access_token", side_effect=AssertionError("probed an invalid target")):
    skipped = wmcp.doctor_status({}, project=malformed_project, probe=True)
assert (skipped["state"], skipped["probe_state"], skipped["usable"]) == ("target_invalid", "not_probed", False)
assert "secret-fixture-token" not in json.dumps(good) + json.dumps(denied) + json.dumps(no_tool)

print(
    "  OK  S4: one launch-frame enum, one auth-marker list, one ownership/flag/identity predicate, honest doctor fields"
)
