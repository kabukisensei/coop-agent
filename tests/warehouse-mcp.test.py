#!/usr/bin/env python3
"""Offline Warehouse MCP target and doctor contract tests."""

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "warehouse_mcp", ROOT / "lib" / "warehouse_mcp.py"
)
wmcp = importlib.util.module_from_spec(spec)
sys.modules["warehouse_mcp"] = wmcp
spec.loader.exec_module(wmcp)


def entry(url=wmcp.GLOBAL_SQL_ENDPOINT_URL):
    return {
        "command": "npx",
        "args": [
            "-y",
            "mcp-remote@0.1.38",
            url,
            "--transport",
            "http-only",
            "--silent",
        ],
    }


# Configuration alone is registered, not healthy; all documented spellings work.
cfg = {"mcpServers": {"fabric-sqlendpoint": entry()}}
assert wmcp.doctor_status(cfg)["state"] == "registered"
for spelling in (
    "executeSQL",
    "execute_query",
    "fabric-sqlendpoint-execute_query",
    "fabric_sqlendpoint_execute_query",
):
    assert wmcp.doctor_status(cfg, [{"name": spelling}])["state"] == "registered"
assert wmcp.doctor_status(cfg, [{"name": "listSchemas"}])["state"] == "tool_missing"
assert wmcp.doctor_status({}, ["executeSQL"])["state"] == "unavailable"
assert (
    wmcp.sqlendpoint_config_status(entry("https://evil.example/sqlEndpoint"))
    == "target_invalid"
)
assert "token" not in json.dumps(entry()).lower()

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
wrong_cfg = {
    "mcpServers": {
        "fabric-sqlendpoint": entry(
            item_url.replace(item, "33333333-3333-3333-3333-333333333333")
        )
    }
}
assert (
    wmcp.doctor_status(wrong_cfg, [{"name": "executeSQL"}], project=project)["state"]
    == "target_invalid"
)

# Probe uses an already-present az token, validates item metadata, then tools/list.
# These seams stand in for az and protected HTTP; no subprocess/network/login occurs.
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
        {"mcpServers": {"fabric-sqlendpoint": entry(item_url)}},
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
        {"mcpServers": {"fabric-sqlendpoint": entry(lakehouse_target.url)}},
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
            {"mcpServers": {"fabric-sqlendpoint": entry(item_url)}},
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
            {"mcpServers": {"fabric-sqlendpoint": entry(item_url)}},
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

# Direct streamable-HTTP parser: initialize, notification, tools/list; token never returned.
responses = iter(
    [
        ({"result": {"protocolVersion": wmcp.MCP_PROTOCOL_VERSION}}, "ok", "session-1"),
        ({}, "ok", "session-1"),
        ({"result": {"tools": [{"name": "execute_query"}]}}, "ok", "session-1"),
    ]
)
original_post = wmcp._mcp_post
try:
    wmcp._mcp_post = lambda *a, **k: next(responses)
    tools, state = wmcp.mcp_tools_list(
        wmcp.GLOBAL_SQL_ENDPOINT_URL, "secret-fixture-token", timeout=1
    )
    assert state == "ok" and wmcp.classify_tools(tools) == "registered"
finally:
    wmcp._mcp_post = original_post

print(
    "  OK  Warehouse MCP doctor is token-safe, bounded-by-contract, tool-aware, and target-aware"
)
