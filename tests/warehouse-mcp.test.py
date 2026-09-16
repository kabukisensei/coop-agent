#!/usr/bin/env python3
"""Offline Warehouse MCP target and doctor contract tests."""

import importlib.util
import json
import subprocess
import sys
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
    return {
        "url": url,
        "auth": "bearer",
        "bearerTokenEnv": wmcp.FABRIC_TOKEN_ENV,
        "lifecycle": "lazy",
    }


def managed_config(url=wmcp.GLOBAL_SQL_ENDPOINT_URL):
    return {
        "mcpServers": {"fabric-sqlendpoint": entry(url)},
        "_coop": {"schema_version": 1, "managed_servers": ["fabric-sqlendpoint"]},
    }


# Configuration alone is registered, not healthy; all documented spellings work.
cfg = managed_config()
assert wmcp.doctor_status(cfg)["state"] == "registered"
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

# Azure CLI token acquisition supports Windows az.CMD without shell=True and
# reports launch/timeout/command/output failures truthfully without leaking tokens.
secret_token = "secret-regression-token"
valid_token_result = subprocess.CompletedProcess(
    args=[], returncode=0, stdout=json.dumps({"accessToken": secret_token}), stderr=""
)
az_cmd_path = r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.CMD"
cmd_exe = r"C:\Windows\System32\cmd.exe"
with (
    mock.patch.object(wmcp, "_is_windows", return_value=True),
    mock.patch.object(wmcp.shutil, "which", return_value=az_cmd_path),
    mock.patch.dict(wmcp.os.environ, {"COMSPEC": cmd_exe}),
    mock.patch.object(wmcp.subprocess, "run", return_value=valid_token_result) as run,
):
    token, state = wmcp.az_access_token()
    assert (token, state) == (secret_token, "ok")
    windows_cmd = run.call_args.args[0]
    assert windows_cmd == [
        cmd_exe,
        "/d",
        "/c",
        "az",
        "account",
        "get-access-token",
        "--resource",
        wmcp.FABRIC_RESOURCE,
        "--output",
        "json",
    ]
    assert windows_cmd[0] != "az"
    assert run.call_args.kwargs["timeout"] == 8
    assert run.call_args.kwargs["shell"] is False

with (
    mock.patch.object(wmcp, "_is_windows", return_value=False),
    mock.patch.object(wmcp.shutil, "which", return_value="/usr/bin/az"),
    mock.patch.object(wmcp.subprocess, "run", return_value=valid_token_result) as run,
):
    assert wmcp.az_access_token() == (secret_token, "ok")
    assert run.call_args.args[0] == [
        "az",
        "account",
        "get-access-token",
        "--resource",
        wmcp.FABRIC_RESOURCE,
        "--output",
        "json",
    ]
    assert run.call_args.kwargs["timeout"] == 8
    assert run.call_args.kwargs["shell"] is False

with (
    mock.patch.object(wmcp, "_is_windows", return_value=True),
    mock.patch.object(wmcp.shutil, "which", return_value=None),
    mock.patch.dict(wmcp.os.environ, {"COMSPEC": cmd_exe}),
    mock.patch.object(wmcp.subprocess, "run") as run,
):
    assert wmcp.az_access_token() == ("", "azure_cli_unavailable")
    run.assert_not_called()

for launch_error in (FileNotFoundError(), OSError("cannot launch")):
    with (
        mock.patch.object(wmcp, "_is_windows", return_value=True),
        mock.patch.object(wmcp.shutil, "which", return_value=az_cmd_path),
        mock.patch.dict(wmcp.os.environ, {"COMSPEC": cmd_exe}),
        mock.patch.object(wmcp.subprocess, "run", side_effect=launch_error),
    ):
        assert wmcp.az_access_token() == ("", "token_launch_failed")

with (
    mock.patch.object(wmcp, "_is_windows", return_value=True),
    mock.patch.object(wmcp.shutil, "which", return_value=az_cmd_path),
    mock.patch.dict(wmcp.os.environ, {"COMSPEC": cmd_exe}),
    mock.patch.object(
        wmcp.subprocess,
        "run",
        side_effect=subprocess.TimeoutExpired(["az"], 8, output=secret_token),
    ),
):
    assert wmcp.az_access_token() == ("", "token_timeout")

for stderr, expected in (
    ("ERROR: Please run 'az login' to setup account.", "auth_required"),
    ("ERROR: transport helper failed", "token_command_failed"),
    (
        "'az' is not recognized as an internal or external command",
        "azure_cli_unavailable",
    ),
):
    failed = subprocess.CompletedProcess(
        args=[], returncode=1, stdout="", stderr=stderr
    )
    with (
        mock.patch.object(wmcp, "_is_windows", return_value=True),
        mock.patch.object(wmcp.shutil, "which", return_value=az_cmd_path),
        mock.patch.dict(wmcp.os.environ, {"COMSPEC": cmd_exe}),
        mock.patch.object(wmcp.subprocess, "run", return_value=failed),
    ):
        assert wmcp.az_access_token() == ("", expected)

for stdout in ("", "not-json", "{}", '{"accessToken": ""}'):
    malformed = subprocess.CompletedProcess(
        args=[], returncode=0, stdout=stdout, stderr=""
    )
    with (
        mock.patch.object(wmcp, "_is_windows", return_value=True),
        mock.patch.object(wmcp.shutil, "which", return_value=az_cmd_path),
        mock.patch.dict(wmcp.os.environ, {"COMSPEC": cmd_exe}),
        mock.patch.object(wmcp.subprocess, "run", return_value=malformed),
    ):
        token, state = wmcp.az_access_token()
        assert (token, state) == ("", "token_output_invalid")
        assert secret_token not in state


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
    mock.patch.object(wmcp, "_is_windows", return_value=True),
    mock.patch.object(wmcp.shutil, "which", return_value=az_cmd_path),
    mock.patch.dict(wmcp.os.environ, {"COMSPEC": cmd_exe}),
    mock.patch.object(wmcp.subprocess, "run", return_value=valid_token_result),
    mock.patch.object(wmcp, "mcp_tools_list", side_effect=fake_global_list),
):
    windows_probed = wmcp.doctor_status(cfg, project={}, probe=True)
assert windows_probed["state"] == "registered"
assert probe_calls == [(wmcp.GLOBAL_SQL_ENDPOINT_URL, secret_token, 8)]
assert secret_token not in json.dumps(windows_probed)

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
