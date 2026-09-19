#!/usr/bin/env python3
"""Offline Warehouse MCP target and doctor contract tests."""

import importlib.util
import base64
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
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
for doctor_script in (ROOT / "scripts" / "doctor.sh", ROOT / "scripts" / "doctor.ps1"):
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
    assert secret_token not in doctor_text

print(
    "  OK  Warehouse MCP doctor is token-safe, bounded-by-contract, tool-aware, and target-aware"
)
