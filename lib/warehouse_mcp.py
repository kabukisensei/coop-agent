#!/usr/bin/env python3
"""Deterministic helpers for Fabric Warehouse SQL endpoint MCP configuration.

The runtime MCP server is Microsoft's managed direct HTTP endpoint. This module
does not execute SQL. Live probes are metadata-only and bounded; auth failures are
reported as states instead of triggering login or OAuth registration.
"""

from __future__ import annotations

import argparse
import base64
import json
import ntpath
import os
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
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
SQL_RESOURCE = "https://database.windows.net/"
TOKEN_RESOURCES = {FABRIC_RESOURCE, SQL_RESOURCE}
FABRIC_TOKEN_ENV = "COOP_FABRIC_MCP_TOKEN"
GLOBAL_SQL_ENDPOINT_URL = f"{FABRIC_RESOURCE}/v1/mcp/dataPlane/sqlEndpoint"
REQUEST_HEADERS_HELPER = str(
    Path(__file__).resolve().parent / "fabric_request_headers.mjs"
)
TOKEN_FRAME_RE = re.compile(rb"^coop-azure-token-v1\t([A-Za-z0-9_-]+)\tend$")
MAX_TOKEN_HELPER_OUTPUT = 32 * 1024
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
MCP_PROTOCOL_VERSION = "2024-11-05"


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    """Never forward a Fabric bearer to a redirected origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_HTTP_OPENER = urllib.request.build_opener(_RejectRedirects())


def _http_open(request: urllib.request.Request, timeout: int):
    return _HTTP_OPENER.open(request, timeout=timeout)


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
    # Match the other integration flags: only the JSON/YAML boolean true opts in.
    # The canonical spelling wins when both are present, including when its value
    # is malformed, so an alias cannot turn a rejected canonical value into an
    # enabled SQL execution surface.
    if "fabric_sql_endpoint" in integrations:
        return integrations["fabric_sql_endpoint"] is True
    if "fabric-sqlendpoint" in integrations:
        return integrations["fabric-sqlendpoint"] is True
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
    if set(entry) != {
        "url",
        "auth",
        "requestHeadersCommand",
        "requestTimeoutMs",
        "lifecycle",
        "_coop_target",
    }:
        return "unavailable"
    raw_url = entry.get("url")
    url = raw_url if isinstance(raw_url, str) else ""
    header = entry.get("requestHeadersCommand")
    target = entry.get("_coop_target")
    target_keys = {
        "scope",
        "workspace_id",
        "item_id",
        "item_type",
        "reason",
        "client",
        "tenant_id",
        "environment",
        "item_name",
    }
    if (
        entry.get("auth") is not False
        or entry.get("requestTimeoutMs") != 60000
        or entry.get("lifecycle") != "lazy"
        or not isinstance(header, dict)
        or set(header) != {"command", "args", "timeoutMs"}
        or header.get("command") != "node"
        or header.get("args") != [REQUEST_HEADERS_HELPER, url]
        or header.get("timeoutMs") != 10000
        or not isinstance(target, dict)
        or set(target) != target_keys
        or any(not isinstance(target.get(key), str) for key in target_keys)
    ):
        return "unavailable"
    if url == GLOBAL_SQL_ENDPOINT_URL:
        return (
            "registered"
            if target["scope"] == "global"
            and target["workspace_id"] == ""
            and target["item_id"] == ""
            else "unavailable"
        )
    m = re.match(
        rf"^{re.escape(FABRIC_RESOURCE)}/v1/mcp/dataPlane/workspaces/({UUID_RE.pattern[1:-1]})/items/({UUID_RE.pattern[1:-1]})/sqlEndpoint$",
        url,
    )
    if not m:
        return "target_invalid"
    return (
        "registered"
        if target["scope"] == "item"
        and canonical_uuid(target["workspace_id"]) == canonical_uuid(m.group(1))
        and canonical_uuid(target["item_id"]) == canonical_uuid(m.group(2))
        else "unavailable"
    )


def registered_target(entry: Any) -> SqlEndpointTarget | None:
    if sqlendpoint_config_status(entry) != "registered":
        return None
    raw_url = entry.get("url")
    url = raw_url if isinstance(raw_url, str) else ""
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


def _is_windows() -> bool:
    return os.name == "nt"


def _native_node() -> str | None:
    candidate = shutil.which("node")
    if not candidate:
        return None
    try:
        node = Path(candidate).resolve(strict=True)
        cwd = Path.cwd().resolve(strict=True)
        if not node.is_absolute() or not node.is_file() or node.is_relative_to(cwd):
            return None
        if _is_windows():
            if node.suffix.lower() != ".exe":
                return None
        elif not os.access(node, os.X_OK):
            return None
        return str(node)
    except (OSError, RuntimeError):
        return None


def _token_helper_environment() -> dict[str, str]:
    allowed = {
        "PATH",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "APPDATA",
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
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
    return {
        key: value
        for key, value in os.environ.items()
        if key in allowed and value and "\0" not in value
    }


def _windows_taskkill_command(pid: int) -> list[str] | None:
    raw_root = os.environ.get("SystemRoot", "")
    if not raw_root or "\0" in raw_root or not ntpath.isabs(raw_root):
        return None
    try:
        system_root = Path(raw_root).resolve(strict=True)
        system32 = (system_root / "System32").resolve(strict=True)
        taskkill = (system32 / "taskkill.exe").resolve(strict=True)
        if not taskkill.is_file() or taskkill.parent != system32:
            return None
    except (OSError, RuntimeError):
        return None
    return [str(taskkill), "/PID", str(pid), "/T", "/F"]


def _terminate_token_helper_tree(proc: subprocess.Popen[bytes]) -> None:
    if _is_windows():
        taskkill = _windows_taskkill_command(proc.pid)
        if taskkill:
            try:
                subprocess.run(
                    taskkill,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env={"SystemRoot": ntpath.dirname(ntpath.dirname(taskkill[0]))},
                    shell=False,
                    timeout=2,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        try:
            proc.kill()
        except OSError:
            pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            proc.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _run_token_helper(
    command: list[str], timeout: int
) -> tuple[int, bytes, bytes, bool]:
    windows = _is_windows()
    proc = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_token_helper_environment(),
        shell=False,
        start_new_session=not windows,
        creationflags=(
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if windows else 0
        ),
    )
    streams: list[bytes] = [b"", b""]
    overflow = threading.Event()

    def read_stream(index: int) -> None:
        pipe = proc.stdout if index == 0 else proc.stderr
        assert pipe is not None
        data = pipe.read(MAX_TOKEN_HELPER_OUTPUT + 1)
        streams[index] = data
        if len(data) > MAX_TOKEN_HELPER_OUTPUT:
            overflow.set()

    readers = [threading.Thread(target=read_stream, args=(index,)) for index in (0, 1)]
    for reader in readers:
        reader.start()
    timed_out = False
    deadline = time.monotonic() + timeout
    while proc.poll() is None:
        if overflow.is_set():
            _terminate_token_helper_tree(proc)
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            _terminate_token_helper_tree(proc)
            break
        try:
            proc.wait(timeout=min(0.05, remaining))
        except subprocess.TimeoutExpired:
            pass
    for reader in readers:
        reader.join(timeout=1)
    if overflow.is_set() and proc.poll() is None:
        _terminate_token_helper_tree(proc)
    return (
        24 if overflow.is_set() else proc.returncode,
        streams[0],
        streams[1],
        timed_out,
    )


def _parse_token_frame(stdout: bytes) -> str | None:
    match = TOKEN_FRAME_RE.fullmatch(stdout)
    if not match:
        return None
    encoded = match.group(1)
    try:
        token_bytes = base64.b64decode(
            encoded + b"=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        )
        if base64.urlsafe_b64encode(token_bytes).rstrip(b"=") != encoded:
            return None
        token = token_bytes.decode("ascii")
    except (ValueError, UnicodeDecodeError):
        return None
    if not (0 < len(token) <= 16384) or any(
        not 0x21 <= ord(char) <= 0x7E for char in token
    ):
        return None
    return token


def az_access_token(
    timeout: int = 10, resource: str = FABRIC_RESOURCE
) -> tuple[str, str]:
    if resource not in TOKEN_RESOURCES:
        return "", "token_command_failed"
    node = _native_node()
    if not node:
        return "", "azure_cli_unavailable"
    try:
        code, stdout, stderr, timed_out = _run_token_helper(
            [node, REQUEST_HEADERS_HELPER, "--token", resource], timeout
        )
    except OSError:
        return "", "token_launch_failed"
    if timed_out:
        return "", "token_timeout"
    if stderr:
        return "", "token_output_invalid"
    if code != 0:
        return "", {
            20: "azure_cli_unavailable",
            21: "token_launch_failed",
            22: "token_timeout",
            24: "token_output_invalid",
            25: "auth_required",
        }.get(code, "token_command_failed")
    token = _parse_token_frame(stdout)
    return (token, "ok") if token is not None else ("", "token_output_invalid")


def fabric_get_json(
    url: str, token: str, timeout: int = 8
) -> tuple[dict[str, Any], str]:
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}
    )
    try:
        with _http_open(req, timeout) as resp:
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
        with _http_open(req, timeout) as resp:
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
            expected_id = message.get("id")
            if expected_id is not None and (
                value.get("jsonrpc") != "2.0"
                or value.get("id") != expected_id
                or "error" in value
            ):
                continue
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
    raw_meta = mcp_config.get("_coop")
    meta: dict[str, Any] = raw_meta if isinstance(raw_meta, dict) else {}
    raw_managed = meta.get("managed_servers")
    managed: list[Any] = raw_managed if isinstance(raw_managed, list) else []
    registered = isinstance(entry, dict) and "fabric-sqlendpoint" in managed
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
    launch = sub.add_parser("launch-token")
    launch.add_argument("mcp_config")
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
    if args.cmd == "launch-token":
        try:
            cfg = json.loads(Path(args.mcp_config).read_text(encoding="utf-8-sig"))
        except Exception:
            cfg = {}
        raw_servers = cfg.get("mcpServers") if isinstance(cfg, dict) else None
        servers = raw_servers if isinstance(raw_servers, dict) else {}
        raw_meta = cfg.get("_coop") if isinstance(cfg, dict) else None
        meta = raw_meta if isinstance(raw_meta, dict) else {}
        raw_managed = meta.get("managed_servers")
        managed = raw_managed if isinstance(raw_managed, list) else []
        entry = servers.get("fabric-sqlendpoint")
        if "fabric-sqlendpoint" not in managed or entry is None:
            return 0
        if sqlendpoint_config_status(entry) != "registered":
            sys.stdout.write("warning\tconfig_invalid\tend")
            return 0
        token, state = az_access_token()
        if state == "ok":
            sys.stdout.write("token\t" + token + "\tend")
            return 0
        sys.stdout.write("warning\t" + state + "\tend")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
