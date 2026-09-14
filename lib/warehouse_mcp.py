#!/usr/bin/env python3
"""Deterministic helpers for Fabric Warehouse SQL endpoint MCP configuration.

The runtime MCP server is Microsoft's managed remote HTTP endpoint. This module
does not execute SQL. Live probes are metadata-only and bounded; auth failures are
reported as states instead of triggering login.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from _yaml import load as load_yaml
except Exception:  # pragma: no cover - import fallback for direct embedding
    load_yaml = None

FABRIC_RESOURCE = "https://api.fabric.microsoft.com"
GLOBAL_SQL_ENDPOINT_URL = f"{FABRIC_RESOURCE}/v1/mcp/dataPlane/sqlEndpoint"
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
WAREHOUSE_TYPES = {"Warehouse", "Lakehouse"}
COMPATIBLE_SQL_TOOLS = {
    "executeSQL",
    "execute_query",
    "fabric-sqlendpoint-execute_query",
    "fabric_sqlendpoint_execute_query",
}
MCP_REMOTE_PIN = "mcp-remote@0.1.38"
MCP_PROTOCOL_VERSION = "2024-11-05"


@dataclass(frozen=True)
class SqlEndpointTarget:
    url: str
    scope: str
    workspace_id: str = ""
    item_id: str = ""
    validation_item_id: str = ""
    item_type: str = ""
    reason: str = ""


def is_uuid(value: Any) -> bool:
    return isinstance(value, str) and bool(UUID_RE.match(value.strip()))


def canonical_uuid(value: str) -> str:
    return value.strip().lower()


def find_project_yml(start: Path) -> Path | None:
    d = start.resolve()
    for _ in range(8):
        p = d / ".coop" / "project.yml"
        if p.is_file():
            return p
        if d.parent == d:
            break
        d = d.parent
    return None


def load_project(path: Path | None) -> dict[str, Any]:
    if not path or not path.is_file() or load_yaml is None:
        return {}
    data = load_yaml(str(path))
    return data if isinstance(data, dict) else {}


def project_sqlendpoint_enabled(project: dict[str, Any]) -> bool:
    mcp = project.get("mcp")
    if not isinstance(mcp, dict):
        return True
    entry = mcp.get("fabric_sqlendpoint", mcp.get("fabric-sqlendpoint", {}))
    if isinstance(entry, dict) and entry.get("enabled") is False:
        return False
    return True


def machine_sqlendpoint_enabled(config: dict[str, Any]) -> bool:
    raw_integrations = config.get("integrations")
    integrations: dict[str, Any] = (
        raw_integrations if isinstance(raw_integrations, dict) else {}
    )
    for key in ("fabric_sql_endpoint", "fabric-sqlendpoint"):
        if key in integrations:
            return integrations[key] is not False
    # Migration safety: an existing explicit opt-out of the original Fabric
    # integration must not acquire a new SQL execution surface merely because
    # this more-specific setting did not exist yet. An explicit new setting is
    # authoritative and may enable the endpoint independently.
    return integrations.get("fabric", True) is not False


def project_target(project: dict[str, Any]) -> SqlEndpointTarget:
    raw_fabric = project.get("fabric")
    fabric: dict[str, Any] = raw_fabric if isinstance(raw_fabric, dict) else {}
    target_configured = "default_sql_endpoint" in fabric
    raw_default = fabric.get("default_sql_endpoint")
    default: dict[str, Any] = raw_default if isinstance(raw_default, dict) else {}
    workspace_id = fabric.get("default_workspace_id", "")
    if not isinstance(workspace_id, str):
        workspace_id = ""
    source_item_id = default.get("item_id", "")
    item_type = default.get("item_type", "")
    if isinstance(item_type, str):
        item_type = item_type.strip()
    else:
        item_type = ""
    endpoint_item_id = source_item_id
    if item_type == "Lakehouse":
        sql_props = (
            default.get("sqlEndpointProperties")
            or default.get("sql_endpoint_properties")
            or {}
        )
        endpoint_item_id = (
            sql_props.get("id", "") if isinstance(sql_props, dict) else ""
        )
    if (
        is_uuid(workspace_id)
        and is_uuid(source_item_id)
        and is_uuid(endpoint_item_id)
        and item_type in WAREHOUSE_TYPES
    ):
        workspace_id = canonical_uuid(workspace_id)
        source_item_id = canonical_uuid(source_item_id)
        endpoint_item_id = canonical_uuid(endpoint_item_id)
        return SqlEndpointTarget(
            url=f"{FABRIC_RESOURCE}/v1/mcp/dataPlane/workspaces/{workspace_id}/items/{endpoint_item_id}/sqlEndpoint",
            scope="item",
            workspace_id=workspace_id,
            item_id=endpoint_item_id,
            validation_item_id=source_item_id,
            item_type=item_type,
            reason="project_ids",
        )
    if target_configured:
        return SqlEndpointTarget(
            url="",
            scope="invalid",
            workspace_id=(
                canonical_uuid(workspace_id) if is_uuid(workspace_id) else ""
            ),
            item_id=(
                canonical_uuid(endpoint_item_id) if is_uuid(endpoint_item_id) else ""
            ),
            validation_item_id=(
                canonical_uuid(source_item_id) if is_uuid(source_item_id) else ""
            ),
            item_type=item_type,
            reason="explicit_project_target_invalid",
        )
    return SqlEndpointTarget(
        url=GLOBAL_SQL_ENDPOINT_URL,
        scope="global",
        reason="missing_unambiguous_project_ids",
    )


def select_target(project: dict[str, Any]) -> SqlEndpointTarget:
    target = project_target(project)
    if target.scope in {"item", "invalid"}:
        return target
    return SqlEndpointTarget(
        url=GLOBAL_SQL_ENDPOINT_URL, scope="global", reason=target.reason
    )


def classify_tools(tools: list[Any]) -> str:
    names: set[str] = set()
    for tool in tools:
        if isinstance(tool, dict) and isinstance(tool.get("name"), str):
            names.add(tool["name"])
        elif isinstance(tool, str):
            names.add(tool)
    if any(name in COMPATIBLE_SQL_TOOLS for name in names):
        return "registered"
    return "tool_missing" if names else "unavailable"


def sqlendpoint_config_status(entry: Any) -> str:
    if not isinstance(entry, dict):
        return "unavailable"
    args = entry.get("args")
    if entry.get("command") != "npx" or not isinstance(args, list):
        return "unavailable"
    if any(re.search(r"(?i)(bearer|accessToken|token)", str(a)) for a in args):
        return "unavailable"
    expected = ["-y", MCP_REMOTE_PIN]
    if (
        args[:2] != expected
        or "--transport" not in args
        or "http-only" not in args
        or "--silent" not in args
    ):
        return "unavailable"
    url = args[2] if len(args) > 2 and isinstance(args[2], str) else ""
    if url == GLOBAL_SQL_ENDPOINT_URL:
        return "registered"
    m = re.match(
        rf"^{re.escape(FABRIC_RESOURCE)}/v1/mcp/dataPlane/workspaces/({UUID_RE.pattern[1:-1]})/items/({UUID_RE.pattern[1:-1]})/sqlEndpoint$",
        url,
    )
    return "registered" if m else "target_invalid"


def registered_target(entry: Any) -> SqlEndpointTarget | None:
    if sqlendpoint_config_status(entry) != "registered":
        return None
    args = entry.get("args", [])
    url = args[2] if len(args) > 2 and isinstance(args[2], str) else ""
    if url == GLOBAL_SQL_ENDPOINT_URL:
        return SqlEndpointTarget(url=url, scope="global", reason="registered")
    m = re.match(
        rf"^{re.escape(FABRIC_RESOURCE)}/v1/mcp/dataPlane/workspaces/({UUID_RE.pattern[1:-1]})/items/({UUID_RE.pattern[1:-1]})/sqlEndpoint$",
        url,
    )
    if not m:
        return None
    return SqlEndpointTarget(
        url=url,
        scope="item",
        workspace_id=canonical_uuid(m.group(1)),
        item_id=canonical_uuid(m.group(2)),
        reason="registered",
    )


def same_target(
    registered: SqlEndpointTarget | None, expected: SqlEndpointTarget
) -> bool:
    if registered is None:
        return False
    if expected.scope == "global":
        return registered.scope == "global"
    return (
        registered.scope == "item"
        and registered.workspace_id == expected.workspace_id
        and registered.item_id == expected.item_id
    )


def az_access_token(timeout: int = 8) -> tuple[str, str]:
    cmd = [
        "az",
        "account",
        "get-access-token",
        "--resource",
        FABRIC_RESOURCE,
        "--output",
        "json",
    ]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return "", "auth_required"
    if proc.returncode != 0:
        return "", "auth_required"
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return "", "auth_required"
    token = data.get("accessToken")
    return (token, "ok") if isinstance(token, str) and token else ("", "auth_required")


def fabric_get_json(
    url: str, token: str, timeout: int = 8
) -> tuple[dict[str, Any], str]:
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(1024 * 1024)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return {}, "auth_required"
        if exc.code == 404:
            return {}, "target_invalid"
        return {}, "unavailable"
    except (urllib.error.URLError, TimeoutError):
        return {}, "unavailable"
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}, "unavailable"
    return (value if isinstance(value, dict) else {}), "ok"


def validate_item_target(target: SqlEndpointTarget, token: str) -> str:
    if target.scope != "item":
        return "ok"
    validation_id = target.validation_item_id or target.item_id
    url = f"{FABRIC_RESOURCE}/v1/workspaces/{target.workspace_id}/items/{validation_id}"
    item, state = fabric_get_json(url, token)
    if state != "ok":
        return state
    item_type = item.get("type")
    if item_type != target.item_type:
        return "target_invalid"
    if item_type == "Lakehouse":
        props = (
            item.get("properties") if isinstance(item.get("properties"), dict) else {}
        )
        sql_props = (
            props.get("sqlEndpointProperties")
            if isinstance(props.get("sqlEndpointProperties"), dict)
            else {}
        )
        if canonical_uuid(str(sql_props.get("id", ""))) != target.item_id:
            return "target_invalid"
    return "ok"


def _mcp_post(
    url: str,
    token: str,
    message: dict[str, Any],
    *,
    timeout: int,
    session_id: str = "",
    allow_empty_notification: bool = False,
) -> tuple[dict[str, Any], str, str]:
    """POST one streamable-HTTP MCP message without starting an OAuth client."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(
        url,
        data=json.dumps(message, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(1024 * 1024).decode("utf-8", errors="strict")
            returned_session = resp.headers.get("Mcp-Session-Id", session_id)
            status_code = getattr(resp, "status", None) or resp.getcode()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return {}, "auth_required", session_id
        if exc.code == 404:
            return {}, "target_invalid", session_id
        return {}, "unavailable", session_id
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError):
        return {}, "unavailable", session_id

    # Streamable HTTP notifications have no JSON-RPC response. Microsoft's
    # endpoint may acknowledge notifications/initialized with 202 or 204 and
    # an empty body; request messages still fail closed on missing/invalid JSON.
    if allow_empty_notification and not raw.strip() and status_code in (202, 204):
        return {}, "ok", returned_session

    # Streamable HTTP requests may return JSON directly or SSE `data:` records.
    candidates = [raw]
    candidates.extend(
        line[5:].strip() for line in raw.splitlines() if line.startswith("data:")
    )
    for candidate in reversed(candidates):
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value, "ok", returned_session
    return {}, "unavailable", returned_session


def mcp_tools_list(url: str, token: str, timeout: int = 8) -> tuple[list[Any], str]:
    """Initialize and discover tools directly with an existing Azure token.

    Doctor intentionally does not execute mcp-remote: doing so could initiate its
    native interactive OAuth flow. The token is kept only in request headers and
    is never returned or printed.
    """
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "coop-doctor", "version": "0"},
        },
    }
    response, state, session = _mcp_post(url, token, init, timeout=timeout)
    if state != "ok" or not isinstance(response.get("result"), dict):
        return [], state if state != "ok" else "unavailable"
    initialized = {
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {},
    }
    _, state, session = _mcp_post(
        url,
        token,
        initialized,
        timeout=timeout,
        session_id=session,
        allow_empty_notification=True,
    )
    if state != "ok":
        return [], state
    listed = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    response, state, _ = _mcp_post(
        url, token, listed, timeout=timeout, session_id=session
    )
    if state != "ok":
        return [], state
    raw_result = response.get("result")
    result: dict[str, Any] = raw_result if isinstance(raw_result, dict) else {}
    tools = result.get("tools", [])
    if not isinstance(tools, list):
        return [], "unavailable"
    return tools, "ok"


def doctor_status(
    mcp_config: dict[str, Any],
    tools: list[Any] | None = None,
    *,
    project: dict[str, Any] | None = None,
    probe: bool = False,
) -> dict[str, Any]:
    servers = (
        mcp_config.get("mcpServers")
        if isinstance(mcp_config.get("mcpServers"), dict)
        else {}
    )
    entry = servers.get("fabric-sqlendpoint")
    registered = isinstance(entry, dict)
    state = sqlendpoint_config_status(entry) if registered else "unavailable"
    target = select_target(project or {})
    actual_target = registered_target(entry) if registered else None
    if target.scope == "invalid":
        state = "target_invalid"
    elif state == "registered" and not same_target(actual_target, target):
        state = "target_invalid"
    if state == "registered" and probe:
        token, auth = az_access_token()
        if auth != "ok":
            state = auth
    else:
        token = ""
    if (
        state == "registered"
        and probe
        and actual_target
        and actual_target.scope == "item"
    ):
        actual_target = SqlEndpointTarget(
            url=actual_target.url,
            scope=actual_target.scope,
            workspace_id=actual_target.workspace_id,
            item_id=actual_target.item_id,
            validation_item_id=target.validation_item_id,
            item_type=target.item_type,
            reason=actual_target.reason,
        )
        item_state = validate_item_target(actual_target, token)
        if item_state != "ok":
            state = item_state
    if (
        state == "registered"
        and tools is None
        and probe
        and isinstance(entry, dict)
        and actual_target is not None
    ):
        tools, tool_state = mcp_tools_list(actual_target.url, token)
        state = tool_state if tool_state != "ok" else classify_tools(tools)
    elif state == "registered" and tools is not None:
        state = classify_tools(tools)
    return {
        "server": "fabric-sqlendpoint",
        "state": state,
        "registered": registered,
        "compatible_tools": sorted(COMPATIBLE_SQL_TOOLS),
        "target": target.__dict__,
        "registered_target": actual_target.__dict__ if actual_target else None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("target")
    p.add_argument("project", nargs="?")
    d = sub.add_parser("doctor-json")
    d.add_argument("mcp_config")
    d.add_argument("--tools-json", default="")
    d.add_argument("--project", default="")
    d.add_argument("--probe", action="store_true")
    args = parser.parse_args(argv)
    if args.cmd == "target":
        project_path = (
            Path(args.project) if args.project else find_project_yml(Path.cwd())
        )
        print(
            json.dumps(
                select_target(load_project(project_path)),
                default=lambda o: o.__dict__,
                sort_keys=True,
            )
        )
        return 0
    if args.cmd == "doctor-json":
        try:
            cfg = json.loads(Path(args.mcp_config).read_text(encoding="utf-8-sig"))
        except Exception:
            cfg = {}
        tools = None
        if args.tools_json:
            try:
                value = json.loads(args.tools_json)
                tools = value.get("tools", value) if isinstance(value, dict) else value
            except json.JSONDecodeError:
                tools = []
        project = load_project(Path(args.project)) if args.project else {}
        print(
            json.dumps(
                doctor_status(cfg, tools, project=project, probe=args.probe),
                sort_keys=True,
            )
        )
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
