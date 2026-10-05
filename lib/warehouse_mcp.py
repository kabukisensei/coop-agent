#!/usr/bin/env python3
"""Deterministic helpers for Fabric Warehouse SQL endpoint MCP configuration.

The runtime MCP server is Microsoft's managed direct HTTP endpoint. This module
does not execute SQL. Live probes are metadata-only and bounded; auth failures are
reported as states instead of triggering login or OAuth registration.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
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

_LIB_DIR = str(Path(__file__).resolve().parent)
if _LIB_DIR not in sys.path:
    sys.path.insert(0, _LIB_DIR)
import coop_paths  # noqa: E402

FABRIC_RESOURCE = "https://api.fabric.microsoft.com"
SQL_RESOURCE = "https://database.windows.net/"
TOKEN_RESOURCES = {FABRIC_RESOURCE, SQL_RESOURCE}
FABRIC_TOKEN_ENV = "COOP_FABRIC_MCP_TOKEN"
# The one list of launch-token warning states. `launch-token` prints
# `warning<TAB><state><TAB>end` with one of these; lib/fabric_token_runner.mjs
# (the launch-frame validator) accepts exactly this set, and
# tests/warehouse-mcp.test.py asserts the two stay equal.
WARNING_STATES = (
    "config_invalid",
    "azure_cli_unavailable",
    "token_launch_failed",
    "token_timeout",
    "auth_required",
    "token_command_failed",
    "token_output_invalid",
)
MANAGED_SQL_SERVER = "fabric-sqlendpoint"
GLOBAL_SQL_ENDPOINT_URL = f"{FABRIC_RESOURCE}/v1/mcp/dataPlane/sqlEndpoint"
REQUEST_HEADERS_HELPER = str(
    Path(__file__).resolve().parent / "fabric_request_headers.mjs"
)
TOKEN_FRAME_RE = re.compile(rb"^coop-azure-token-v1\t([A-Za-z0-9_-]+)\tend$")
MAX_TOKEN_HELPER_OUTPUT = 32 * 1024
_TOKEN_HELPER_SIGNAL_LOCK = threading.Lock()
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# The one item-scoped Warehouse MCP URL shape (workspace, SQL endpoint item).
ITEM_URL_RE = re.compile(
    rf"^{re.escape(FABRIC_RESOURCE)}/v1/mcp/dataPlane/workspaces/({UUID_RE.pattern[1:-1]})/items/({UUID_RE.pattern[1:-1]})/sqlEndpoint$"
)
# A JWT, and the claims coop binds a session to, are visible ASCII only.
VISIBLE_ASCII_RE = re.compile(r"^[!-~]+$")
MAX_JWT_CHARS = 16384
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
    # The launcher's answer (COOP_PROJECT_YML, bin/coop.ps1): the contract in the
    # client home repository beside this one (master plan C1).
    launched = os.environ.get("COOP_PROJECT_YML", "")
    if launched and Path(launched).is_file():
        return Path(launched)
    return None


def load_project(path: Path | None) -> dict[str, Any]:
    if not path or not path.is_file() or load_yaml is None:
        return {}
    data = load_yaml(str(path))
    return data if isinstance(data, dict) else {}


# --- Client Azure tenant chain (H2) -------------------------------------------
# One place decides which tenant the launch sign-in, the doctor rows and coop's
# own token mints (H2b) use: the project contract's fabric.tenant_id, else the
# onboarding config's azure.tenant_id (client resources only), else nothing.
# A tenant is a canonical GUID or a domain name with at least one dot, so a
# value can never carry shell or cmd.exe metacharacters into an az command line.
TENANT_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)
TENANT_EXIT_CODES = {"ok": 0, "unset": 1, "invalid": 2}


def tenant_value(value: Any) -> tuple[str, str]:
    """Classify one tenant setting as ('ok', tenant), ('unset', '') or ('invalid', '').

    Non-strings, blanks and TODO placeholders (any letter case) are unset. Any
    other value must be a GUID or a dotted domain; placeholders such as 'TBD' or
    'none' are invalid, and a rejected value is never returned.
    """
    if not isinstance(value, str):
        return "unset", ""
    text = value.strip()
    if not text or text.lower().startswith("todo"):
        return "unset", ""
    if UUID_RE.fullmatch(text) or TENANT_DOMAIN_RE.fullmatch(text):
        return "ok", text
    return "invalid", ""


def coop_config_path() -> Path:
    """~/.coop/config, honouring COOP_DIR exactly as scripts/onboard.py does."""
    return coop_paths.config_path()


def tenant_from_sources(project: Any, config: Any) -> tuple[str, str]:
    """Resolve the tenant chain from an already-loaded contract and config.

    The project value wins. An invalid project value stops the chain: signing in
    to a different tenant than the contract names would be worse than not
    signing in. The config value counts only when azure.purpose is absent or
    'client_resources' (the rule lib/mcp_config.py enforces).
    """
    raw_fabric = project.get("fabric") if isinstance(project, dict) else None
    fabric = raw_fabric if isinstance(raw_fabric, dict) else {}
    state, tenant = tenant_value(fabric.get("tenant_id"))
    if state != "unset":
        return state, tenant
    raw_azure = config.get("azure") if isinstance(config, dict) else None
    azure = raw_azure if isinstance(raw_azure, dict) else {}
    if azure.get("purpose") not in (None, "", "client_resources"):
        return "unset", ""
    return tenant_value(azure.get("tenant_id"))


def resolve_tenant(project_path: Path | None, config_path: Path) -> tuple[str, str]:
    try:
        project = load_project(project_path)
    except Exception:
        project = {}
    try:
        config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except Exception:
        config = {}
    return tenant_from_sources(project, config)


def _direct_sql_target_configured(project_path: Path | None) -> bool:
    """True when the contract's ready default sql_targets entry names its host."""
    try:
        import sql_targets as targets_lib  # noqa: WPS433 (same lib directory)
    except Exception:
        return False
    target = targets_lib.parse_sql_targets(load_project(project_path)).default
    return target is not None and not target.discovered


def launcher_project_yml() -> Path | None:
    """The contract the launcher finds (coop_find_project_yml / Find-CoopProjectYml).

    The nearest .coop/project.yml from the current folder up to the root, else the
    bundled contract, so the launch token mints for the tenant the launch preflight
    signed in to, even from deeper than find_project_yml's eight levels.
    """
    try:
        d = Path.cwd()
        while True:
            candidate = d / ".coop" / "project.yml"
            if candidate.is_file():
                return candidate
            if d.parent == d:
                break
            d = d.parent
        launched = os.environ.get("COOP_PROJECT_YML", "")
        if launched and Path(launched).is_file():
            return Path(launched)
        bundled = Path(__file__).resolve().parent.parent / ".coop" / "project.yml"
        return bundled if bundled.is_file() else None
    except OSError:
        return None


def pinned_tenant(project_path: Path | None) -> str:
    """The tenant coop's own token mints pass to az (H2b), or '' for none.

    Only a resolved tenant pins a mint. Unset or invalid keeps today's unpinned
    az call: the launch preflight and doctor already report an invalid value.
    """
    state, tenant = resolve_tenant(project_path, coop_config_path())
    return tenant if state == "ok" else ""


def project_sqlendpoint_enabled(project: dict[str, Any]) -> bool:
    mcp = project.get("mcp")
    if not isinstance(mcp, dict):
        return True
    entry = mcp.get("fabric_sqlendpoint", mcp.get("fabric-sqlendpoint", {}))
    if isinstance(entry, dict) and entry.get("enabled") is False:
        return False
    return True


def integration_enabled(config: Any, name: str, default: bool = True) -> bool:
    """The one ~/.coop/config integrations flag rule: only the boolean true opts in.

    A missing flag takes `default`; any other value (a string "true", 1, null)
    is off. lib/mcp_config.py's `enabled()` is this function.
    """
    raw_integrations = config.get("integrations") if isinstance(config, dict) else None
    integrations = raw_integrations if isinstance(raw_integrations, dict) else {}
    return integrations.get(name, default) is True


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
        return integration_enabled(config, "fabric_sql_endpoint")
    if MANAGED_SQL_SERVER in integrations:
        return integration_enabled(config, MANAGED_SQL_SERVER)
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


# The former select_target re-derived project_target's global case; one name.
select_target = project_target


def managed_sqlendpoint_entry(mcp_config: Any) -> Any | None:
    """The managed Warehouse MCP entry of an mcp-adapter.json document, or None.

    The one ownership rule: the entry exists under `mcpServers` and `_coop
    .managed_servers` names it (a user-owned entry of the same name is not
    coop's). Doctor, `launch-token` and fabric_sql_query all ask this.
    """
    if not isinstance(mcp_config, dict):
        return None
    raw_servers = mcp_config.get("mcpServers")
    servers = raw_servers if isinstance(raw_servers, dict) else {}
    raw_meta = mcp_config.get("_coop")
    meta = raw_meta if isinstance(raw_meta, dict) else {}
    raw_managed = meta.get("managed_servers")
    managed = raw_managed if isinstance(raw_managed, list) else []
    if MANAGED_SQL_SERVER not in managed:
        return None
    return servers.get(MANAGED_SQL_SERVER)


def jwt_identity(token: Any) -> tuple[str, str, str] | None:
    """(tenant, kind, principal) of a JWT, or None. Mirrors jwtIdentity in
    lib/fabric_request_headers.mjs: at most 16384 visible-ASCII characters,
    three canonical base64url segments, a UTF-8 JSON object payload whose `tid`
    is a GUID (lowercased) and whose `oid` (else `sub`) is a visible-ASCII
    string (lowercased); kind names which claim bound the principal."""
    if (
        not isinstance(token, str)
        or len(token) > MAX_JWT_CHARS
        or not VISIBLE_ASCII_RE.fullmatch(token)
    ):
        return None
    parts = token.split(".")
    if len(parts) != 3:
        return None
    decoded = []
    for part in parts:
        try:
            raw = base64.b64decode(
                part + "=" * (-len(part) % 4), altchars=b"-_", validate=True
            )
        except (ValueError, TypeError):
            return None
        if not raw or base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") != part:
            return None
        decoded.append(raw)
    try:
        claims = json.loads(decoded[1].decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(claims, dict):
        return None
    tenant = claims.get("tid")
    tenant = tenant.lower() if isinstance(tenant, str) else ""
    if isinstance(claims.get("oid"), str):
        kind = "oid"
    elif isinstance(claims.get("sub"), str):
        kind = "sub"
    else:
        return None
    principal = claims[kind]
    if not UUID_RE.fullmatch(tenant) or not VISIBLE_ASCII_RE.fullmatch(principal):
        return None
    return tenant, kind, principal.lower()


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


def same_request_headers_helper(path: Any) -> bool:
    """True when `path` is this install's request-headers helper, or another coop
    install's copy of the same file (byte-identical). The terminal install and
    the coop window package share one profile and one mcp-adapter.json, and each
    `coop sync` writes its own helper path into it; on 2026-10-05 the two
    installs took turns calling the other's config invalid. The content check
    keeps the ownership rule (a helper that is not this release's file is still
    refused) while either install's path passes."""
    if path == REQUEST_HEADERS_HELPER:
        return True
    if not isinstance(path, str) or not path:
        return False
    try:
        other = Path(path)
        if not other.is_absolute() or other.name != "fabric_request_headers.mjs":
            return False
        mine = hashlib.sha256(Path(REQUEST_HEADERS_HELPER).read_bytes()).digest()
        return hashlib.sha256(other.read_bytes()).digest() == mine
    except (OSError, RuntimeError, ValueError):
        return False


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
        or not isinstance(header.get("args"), list)
        or len(header["args"]) != 2
        or not same_request_headers_helper(header["args"][0])
        or header["args"][1] != url
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
    m = ITEM_URL_RE.match(url)
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
    m = ITEM_URL_RE.match(url)
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


def _cwd_may_hold_tools(cwd: Path) -> bool:
    """A working directory that contains the user's home (the home itself, the
    users folder, a drive root) is not a work repo: tools installed under the
    profile (a node from nvm or the coop window package, az.cmd from a per-user
    install) live there legitimately. A launch from such a folder keeps them;
    anywhere else, a binary under the cwd is a planted one and is refused."""
    try:
        return Path.home().resolve(strict=True).is_relative_to(cwd)
    except (OSError, RuntimeError):
        return False


def _native_node() -> str | None:
    candidate = shutil.which("node")
    if not candidate:
        return None
    try:
        node = Path(candidate).resolve(strict=True)
        cwd = Path.cwd().resolve(strict=True)
        if not node.is_absolute() or not node.is_file():
            return None
        if node.is_relative_to(cwd) and not _cwd_may_hold_tools(cwd):
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
    # Python normalizes Windows os.environ keys to uppercase.
    if _is_windows():
        allowed = {key.upper() for key in allowed}
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
    owns_signal = False
    previous_sigterm: Any = None
    caught_signal: tuple[int, Any] | None = None
    proc: subprocess.Popen[bytes] | None = None
    streams: list[bytes] = [b"", b""]
    overflow = threading.Event()
    timed_out = False

    class _TokenHelperInterrupted(BaseException):
        pass

    def on_sigterm(signum: int, frame: Any) -> None:
        nonlocal caught_signal
        if caught_signal is None:
            caught_signal = (signum, frame)
            if proc is not None:
                _terminate_token_helper_tree(proc)
        raise _TokenHelperInterrupted

    if not windows:
        if (
            threading.current_thread() is not threading.main_thread()
            or not _TOKEN_HELPER_SIGNAL_LOCK.acquire(blocking=False)
        ):
            raise OSError("token helper signal ownership unavailable")
        owns_signal = True
        try:
            previous_sigterm = signal.getsignal(signal.SIGTERM)
            signal.signal(signal.SIGTERM, on_sigterm)
        except BaseException:
            _TOKEN_HELPER_SIGNAL_LOCK.release()
            owns_signal = False
            raise

    try:
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

        def read_stream(index: int) -> None:
            pipe = proc.stdout if index == 0 else proc.stderr
            assert pipe is not None
            data = pipe.read(MAX_TOKEN_HELPER_OUTPUT + 1)
            streams[index] = data
            if len(data) > MAX_TOKEN_HELPER_OUTPUT:
                overflow.set()

        readers = [
            threading.Thread(target=read_stream, args=(index,), daemon=True)
            for index in (0, 1)
        ]
        for reader in readers:
            reader.start()
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
    except _TokenHelperInterrupted:
        if proc is not None and proc.poll() is None:
            _terminate_token_helper_tree(proc)
    finally:
        if owns_signal:
            signal.signal(signal.SIGTERM, previous_sigterm)
            _TOKEN_HELPER_SIGNAL_LOCK.release()

    if caught_signal is not None:
        signum, frame = caught_signal
        if previous_sigterm == signal.SIG_DFL:
            os.kill(os.getpid(), signum)
            raise SystemExit(128 + signum)
        if callable(previous_sigterm):
            previous_sigterm(signum, frame)
    if proc is None:
        raise OSError("token helper launch interrupted")
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
    timeout: int = 10, resource: str = FABRIC_RESOURCE, tenant: str = ""
) -> tuple[str, str]:
    """Mint one token through the hardened Node helper.

    A tenant pins the mint (`--tenant <id>`); with none, the helper argv is the
    same as before tenants existed. A tenant that is not exactly a GUID or a
    dotted domain fails closed instead of falling back to az's default account.
    """
    if resource not in TOKEN_RESOURCES:
        return "", "token_command_failed"
    if tenant and tenant_value(tenant) != ("ok", tenant):
        return "", "token_command_failed"
    node = _native_node()
    if not node:
        return "", "azure_cli_unavailable"
    command = [node, REQUEST_HEADERS_HELPER, "--token", resource]
    if tenant:
        command += ["--tenant", tenant]
    try:
        code, stdout, stderr, timed_out = _run_token_helper(command, timeout)
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

    Doctor intentionally speaks to the endpoint itself rather than through the
    adapter or any bridge process, so nothing can start an interactive OAuth
    flow. The token is kept only in request headers and is never returned or
    printed.
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
    tenant: str = "",
) -> dict[str, Any]:
    """Observe the managed Warehouse MCP server; never sign in or execute SQL.

    `state` is the one-word verdict doctor has always printed. The fields added
    for honesty: `config_state` is what the config alone proves (registered |
    unavailable | target_invalid), `probe_state` is what the live probe found
    (not_probed, or ok, or the first failing step's state) and `usable` is true
    only when the probe ran, the target validated and a compatible tool was
    listed. Config alone is registered, never usable.
    """
    entry = managed_sqlendpoint_entry(mcp_config)
    registered = isinstance(entry, dict)
    state = sqlendpoint_config_status(entry) if registered else "unavailable"
    target = project_target(project or {})
    actual_target = registered_target(entry) if registered else None
    if target.scope == "invalid":
        state = "target_invalid"
    elif state == "registered" and not same_target(actual_target, target):
        state = "target_invalid"
    config_state = state
    probed = state == "registered" and probe
    if probed:
        # The probe mints for the client tenant, like the launch; no tenant keeps
        # the unpinned call exactly as it was.
        token, auth = az_access_token(tenant=tenant) if tenant else az_access_token()
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
    if not probed:
        probe_state = "not_probed"
    elif state == "registered":
        probe_state = "ok"
    else:
        probe_state = state
    return {
        "server": MANAGED_SQL_SERVER,
        "state": state,
        "config_state": config_state,
        "probe_state": probe_state,
        "usable": probe_state == "ok",
        "registered": registered,
        "compatible_tools": sorted(COMPATIBLE_SQL_TOOLS),
        "target": target.__dict__,
        "registered_target": actual_target.__dict__ if actual_target else None,
        # The tenant the probe mints for ('' = az's default account).
        "tenant": tenant,
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
    tenant_cmd = sub.add_parser("tenant")
    # The contract the launcher already found (coop_find_project_yml /
    # Find-CoopProjectYml: walk to the root, then the bundled contract), so the
    # tenant comes from the same contract doctor shows. Empty: none was found.
    tenant_cmd.add_argument("--project", default=None)
    args = parser.parse_args(argv)
    if args.cmd == "tenant":
        # Prints the resolved client tenant (nothing otherwise) and exits
        # 0 resolved / 1 unset / 2 invalid. Never writes stderr and never
        # echoes a rejected value; lib/common.ps1 calls this.
        if args.project is not None:
            project_path = Path(args.project) if args.project else None
        else:
            try:
                project_path = find_project_yml(Path.cwd())
            except OSError:
                project_path = None
        state, tenant = resolve_tenant(project_path, coop_config_path())
        if state == "ok":
            print(tenant)
        return TENANT_EXIT_CODES[state]
    if args.cmd == "target":
        project_path = (
            Path(args.project) if args.project else find_project_yml(Path.cwd())
        )
        print(
            json.dumps(
                project_target(load_project(project_path)),
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
        project_path = Path(args.project) if args.project else None
        project = load_project(project_path) if project_path else {}
        print(
            json.dumps(
                doctor_status(
                    cfg,
                    tools,
                    project=project,
                    probe=args.probe,
                    # The same contract as the doctor's Azure sign-in row.
                    tenant=pinned_tenant(project_path),
                ),
                sort_keys=True,
            )
        )
        return 0
    if args.cmd == "launch-token":
        try:
            cfg = json.loads(Path(args.mcp_config).read_text(encoding="utf-8-sig"))
        except Exception:
            cfg = {}
        entry = managed_sqlendpoint_entry(cfg)
        if entry is None:
            # No managed Warehouse server (an Azure SQL-only machine, say): a
            # contract whose default sql_targets entry names its host (SQ2) still
            # needs a session identity, so mint the SQL audience for the same
            # tenant chain. The executor pins its own mint to this token's tid.
            if _direct_sql_target_configured(launcher_project_yml()):
                tenant = pinned_tenant(launcher_project_yml())
                token, state = az_access_token(resource=SQL_RESOURCE, tenant=tenant)
                if state == "ok":
                    sys.stdout.write("token\t" + token + "\tend")
                else:
                    sys.stdout.write("warning\t" + state + "\tend")
            return 0
        if sqlendpoint_config_status(entry) != "registered":
            sys.stdout.write("warning\tconfig_invalid\tend")
            return 0
        # Pin the session identity to the client tenant (H2b). The per-request
        # header helper and fabric_sql_query then pin to this token's tid.
        tenant = pinned_tenant(launcher_project_yml())
        token, state = az_access_token(tenant=tenant) if tenant else az_access_token()
        if state == "ok":
            sys.stdout.write("token\t" + token + "\tend")
            return 0
        if state not in WARNING_STATES:
            state = "token_command_failed"
        sys.stdout.write("warning\t" + state + "\tend")
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
