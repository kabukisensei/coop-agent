#!/usr/bin/env python3
"""Governed stdin/stdout pyodbc executor for one bounded SQL read.

The target comes from the project contract, never from the caller:

- with a `sql_targets:` section (lib/sql_targets.py, master plan SQ1) the ready
  default environment (dev or test, never prod) is the target. Azure SQL
  Database, Fabric SQL database and Synapse serverless entries name their host
  in the contract; Fabric Warehouse / Lakehouse entries carry workspace and item
  ids and the host is still discovered through the Fabric REST API;
- without one, today's path: `fabric.default_sql_endpoint` plus the managed
  `fabric-sqlendpoint` MCP entry coop generated, which must agree.

Every kind authenticates with Entra ID tokens for the `https://database.windows.net/`
audience, pinned to the launch identity's tenant (no launch identity, no mint),
over ODBC Driver 18+, encrypted, with the same query filter, row and byte caps.
`ApplicationIntent=ReadOnly` is added only for an `azure_sql` entry that declares
`read_scale_replicas: true`; elsewhere the read-only guarantee stays the query
filter plus autocommit with no transaction. No credential, connection string,
SQL text or server name appears in a result.
"""

from __future__ import annotations

import base64
import json
import os
import re
import struct
import sys
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any

import sql_targets as targets_lib
import warehouse_mcp as wmcp

SQL_RESOURCE = "https://database.windows.net/"
SQL_COPT_SS_ACCESS_TOKEN = 1256
MAX_ROWS = 1000
CONNECT_TIMEOUT = 15
QUERY_TIMEOUT = 45
MAX_COLUMN_CHARS = 512
MAX_CELL_CHARS = 65_536
MAX_RESULT_BYTES = 1_000_000
DRIVER_RE = re.compile(r"^ODBC Driver (\d+) for SQL Server$")
SAFE_DATABASE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._@&'()+-]{0,159}$")
SAFE_SERVER = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.datawarehouse\.fabric\.microsoft\.com$"
)
DISALLOWED = re.compile(
    r"\b(WITH|UNION|INTERSECT|EXCEPT|APPLY|ALTER|CREATE|DELETE|DENY|DROP|EXEC(?:UTE)?|"
    r"GRANT|INSERT|MERGE|RENAME|REPLACE|REVOKE|TRUNCATE|UPDATE|UPSERT|OPENROWSET|"
    r"OPENQUERY|OPENDATASOURCE|BACKUP|RESTORE|DBCC|WAITFOR|USE|SET|DECLARE|BEGIN|"
    r"COMMIT|ROLLBACK|SAVE|TRANSACTION|PRINT|RAISERROR|THROW|KILL|SHUTDOWN|BULK|"
    r"OPTION|FOR|PERCENT|INTO)\b",
    re.IGNORECASE,
)


def result(state: str, **details: Any) -> dict[str, Any]:
    return {"ok": state == "ok", "state": state, **details}


def bounded_select_limit(sql: Any) -> int | None:
    if (
        not isinstance(sql, str)
        or not sql
        or len(sql) > 100_000
        or any(marker in sql for marker in ("'", '"', "[", "]", "--", "/*", "*/"))
    ):
        return None
    if re.search(r"^\s*GO\s*$", sql, re.MULTILINE | re.IGNORECASE):
        return None
    statement = re.sub(r";\s*$", "", sql.strip())
    if (
        ";" in statement
        or len(re.findall(r"\bSELECT\b", statement, re.IGNORECASE)) != 1
    ):
        return None
    if DISALLOWED.search(statement) or re.search(
        r"\b[A-Za-z_][\w$#]*\s*\.\s*(?:[A-Za-z_][\w$#]*\s*)?\.\s*[A-Za-z_][\w$#]*\b",
        statement,
    ):
        return None
    match = re.match(
        r"^SELECT\s+(?:(?:ALL|DISTINCT)\s+)?TOP\s*(?:\(\s*([1-9]\d*)\s*\)|([1-9]\d*))\s+",
        statement,
        re.IGNORECASE,
    )
    if not match:
        return None
    limit = int(match.group(1) or match.group(2))
    return limit if limit <= MAX_ROWS else None


def pack_access_token(token: str) -> bytes:
    encoded = token.encode("utf-16-le")
    return struct.pack("<I", len(encoded)) + encoded


def select_driver(drivers: list[str]) -> str | None:
    supported = []
    for driver in drivers:
        match = DRIVER_RE.fullmatch(driver)
        if match and int(match.group(1)) >= 18:
            supported.append((int(match.group(1)), driver))
    return max(supported, default=(0, ""))[1] or None


def _jwt_identity(token: str) -> tuple[str, str] | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        tenant = str(claims.get("tid", "")).lower()
        principal = str(claims.get("oid") or claims.get("sub") or "")
    except (ValueError, IndexError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return (tenant, principal) if wmcp.is_uuid(tenant) and principal else None


def _canonical_target(
    project_path: Path,
) -> tuple[wmcp.SqlEndpointTarget | None, str, str]:
    project = wmcp.load_project(project_path)
    target = wmcp.select_target(project)
    raw_default = project.get("fabric", {}).get("default_sql_endpoint", {})
    database = raw_default.get("item_name", "") if isinstance(raw_default, dict) else ""
    if (
        target.scope != "item"
        or not isinstance(database, str)
        or not SAFE_DATABASE.fullmatch(database)
    ):
        return None, "", "target_invalid"
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR", "")
    if not agent_dir:
        return None, "", "managed_config_unavailable"
    try:
        config = json.loads(
            (Path(agent_dir) / "mcp-adapter.json").read_text(encoding="utf-8-sig")
        )
        entry = config["mcpServers"]["fabric-sqlendpoint"]
        managed = config["_coop"]["managed_servers"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return None, "", "managed_config_unavailable"
    registered = (
        wmcp.registered_target(entry) if "fabric-sqlendpoint" in managed else None
    )
    metadata = entry.get("_coop_target", {}) if isinstance(entry, dict) else {}
    if (
        not wmcp.same_target(registered, target)
        or metadata.get("item_name") != database
    ):
        return None, "", "target_mismatch"
    return target, database, "ok"


class ResolvedTarget:
    """What execute() connects to: a host (direct kinds) or Fabric ids (discovered)."""

    __slots__ = ("kind", "environment", "database", "server", "fabric", "connect_timeout", "read_only_intent")

    def __init__(
        self,
        kind: str,
        environment: str,
        database: str,
        *,
        server: str = "",
        fabric: wmcp.SqlEndpointTarget | None = None,
        connect_timeout: int = CONNECT_TIMEOUT,
        read_only_intent: bool = False,
    ) -> None:
        self.kind = kind
        self.environment = environment
        self.database = database
        self.server = server
        self.fabric = fabric
        self.connect_timeout = connect_timeout
        self.read_only_intent = read_only_intent

    def summary(self) -> dict[str, str]:
        return {"environment": self.environment, "kind": self.kind, "database": self.database}


def _contract_target(project: dict[str, Any]) -> tuple[ResolvedTarget | None, str]:
    """The ready default `sql_targets` entry as a ResolvedTarget, or a state."""
    parsed = targets_lib.parse_sql_targets(project)
    target = parsed.default
    if target is None:
        return None, "target_invalid"
    if target.production:
        return None, "target_invalid"
    if target.discovered:
        item_type = targets_lib.FABRIC_ITEM_KINDS[target.kind]
        endpoint_id = target.sql_endpoint_id if target.kind == "fabric_lakehouse" else target.item_id
        fabric = wmcp.SqlEndpointTarget(
            url=f"{wmcp.FABRIC_RESOURCE}/v1/mcp/dataPlane/workspaces/{target.workspace_id}/items/{endpoint_id}/sqlEndpoint",
            scope="item",
            workspace_id=target.workspace_id,
            item_id=endpoint_id,
            validation_item_id=target.item_id,
            item_type=item_type,
            reason="sql_targets",
        )
        return ResolvedTarget(
            target.kind, target.environment, target.database, fabric=fabric, connect_timeout=target.connect_timeout
        ), "ok"
    return ResolvedTarget(
        target.kind,
        target.environment,
        target.database,
        server=target.server,
        connect_timeout=target.connect_timeout,
        read_only_intent=target.kind == "azure_sql" and target.read_scale_replicas,
    ), "ok"


def _legacy_target(project_path: Path) -> tuple[ResolvedTarget | None, str]:
    fabric, database, state = _canonical_target(project_path)
    if state != "ok" or fabric is None:
        return None, state
    kind = "fabric_warehouse" if fabric.item_type == "Warehouse" else "fabric_lakehouse"
    return ResolvedTarget(kind, "", database, fabric=fabric), "ok"


class ResultTooLarge(Exception):
    pass


def _bounded_text(value: str, limit: int) -> str:
    if len(value) > limit or len(value.encode("utf-8")) > limit:
        raise ResultTooLarge
    return value


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _bounded_text(value, MAX_CELL_CHARS)
    if isinstance(value, Decimal):
        return _bounded_text(str(value), MAX_CELL_CHARS)
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, bytes):
        if len(value) > MAX_CELL_CHARS // 2:
            raise ResultTooLarge
        return value.hex()
    return _bounded_text(str(value), MAX_CELL_CHARS)


def _discover_server(target: wmcp.SqlEndpointTarget, token: str) -> tuple[str, str]:
    collection = "warehouses" if target.item_type == "Warehouse" else "lakehouses"
    source_id = target.validation_item_id
    url = (
        f"{wmcp.FABRIC_RESOURCE}/v1/workspaces/{target.workspace_id}/"
        f"{collection}/{source_id}"
    )
    item, state = wmcp.fabric_get_json(url, token)
    if state != "ok":
        return "", state
    if not isinstance(item, dict):
        return "", "endpoint_invalid"
    response_id = item.get("id")
    response_type = item.get("type")
    response_workspace = item.get("workspaceId")
    if (
        not isinstance(response_id, str)
        or not wmcp.is_uuid(response_id)
        or wmcp.canonical_uuid(response_id) != source_id
        or response_type != target.item_type
        or not isinstance(response_workspace, str)
        or not wmcp.is_uuid(response_workspace)
        or wmcp.canonical_uuid(response_workspace) != target.workspace_id
    ):
        return "", "endpoint_invalid"
    properties = item.get("properties")
    if not isinstance(properties, dict):
        return "", "endpoint_invalid"
    if target.item_type == "Warehouse":
        server = properties.get("connectionString", "")
    else:
        sql_properties = properties.get("sqlEndpointProperties")
        if not isinstance(sql_properties, dict):
            return "", "endpoint_invalid"
        endpoint_id = sql_properties.get("id")
        if (
            not isinstance(endpoint_id, str)
            or not wmcp.is_uuid(endpoint_id)
            or wmcp.canonical_uuid(endpoint_id) != target.item_id
        ):
            return "", "endpoint_invalid"
        server = sql_properties.get("connectionString", "")
    if not isinstance(server, str) or not SAFE_SERVER.fullmatch(server):
        return "", "endpoint_invalid"
    return server, "ok"


def execute(payload: Any, *, cwd: Path | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"query", "maximum_rows"}:
        return result("input_invalid")
    query = payload.get("query")
    limit = bounded_select_limit(query)
    maximum_rows = payload.get("maximum_rows", limit)
    if (
        limit is None
        or isinstance(maximum_rows, bool)
        or not isinstance(maximum_rows, int)
        or maximum_rows < 1
        or maximum_rows > MAX_ROWS
    ):
        return result("query_rejected")
    row_limit = min(limit, maximum_rows)
    project_path = wmcp.find_project_yml(cwd or Path.cwd())
    if not project_path:
        return result("project_unavailable")
    project = wmcp.load_project(project_path)
    if targets_lib.parse_sql_targets(project).configured:
        target, state = _contract_target(project)
    else:
        target, state = _legacy_target(project_path)
    if state != "ok" or target is None:
        return result(state)
    try:
        import pyodbc  # type: ignore[import-not-found]
    except (ImportError, OSError):
        return result("pyodbc_unavailable", stage="driver_import")
    driver = select_driver(list(pyodbc.drivers()))
    if not driver:
        return result("odbc_driver_unavailable", minimum_version=18)
    # Every mint is pinned to the launch token's tenant (its tid), not to
    # whichever account az treats as the default; no launch identity, no mint.
    launch_identity = _jwt_identity(os.environ.get(wmcp.FABRIC_TOKEN_ENV, ""))
    if not launch_identity:
        return result("identity_mismatch")
    tenant = launch_identity[0]
    if target.fabric is not None:
        fabric_token, state = wmcp.az_access_token(
            resource=wmcp.FABRIC_RESOURCE, tenant=tenant
        )
        if state != "ok":
            return result(state, stage="fabric_rest_token")
        if _jwt_identity(fabric_token) != launch_identity:
            return result("identity_mismatch")
        server, state = _discover_server(target.fabric, fabric_token)
        if state != "ok":
            return result(state, stage="endpoint_discovery")
    else:
        # A host the contract named: it already matched its kind's pattern in
        # lib/sql_targets.py, so a production or Fabric host cannot hide here.
        server = target.server
    sql_token, state = wmcp.az_access_token(resource=SQL_RESOURCE, tenant=tenant)
    if state != "ok":
        return result(state, stage="database_token")
    if _jwt_identity(sql_token) != launch_identity:
        return result("identity_mismatch")
    connection_string = (
        f"DRIVER={{{driver}}};SERVER={server},1433;DATABASE={{{target.database.replace('}', '}}')}}};"
        "Encrypt=yes;TrustServerCertificate=no;"
    )
    if target.read_only_intent:
        connection_string += "ApplicationIntent=ReadOnly;"
    try:
        connection = pyodbc.connect(
            connection_string,
            attrs_before={SQL_COPT_SS_ACCESS_TOKEN: pack_access_token(sql_token)},
            timeout=target.connect_timeout,
            autocommit=True,
        )
    except Exception:
        return result("connection_failed")
    try:
        # pyodbc applies the connection's query timeout to new cursors.
        connection.timeout = QUERY_TIMEOUT
        cursor = connection.cursor()
        cursor.execute(query)
        columns = [
            _bounded_text(str(item[0]), MAX_COLUMN_CHARS)
            for item in (cursor.description or [])
        ]
        values = []
        serialized_bytes = (
            len(json.dumps(columns, ensure_ascii=False).encode("utf-8")) + 1_024
        )
        if serialized_bytes > MAX_RESULT_BYTES:
            raise ResultTooLarge
        truncated = False
        for index in range(row_limit + 1):
            row = cursor.fetchone()
            if row is None:
                break
            if index == row_limit:
                truncated = True
                break
            materialized = [_json_value(value) for value in row]
            serialized_bytes += (
                len(json.dumps(materialized, ensure_ascii=False).encode("utf-8")) + 1
            )
            if serialized_bytes > MAX_RESULT_BYTES:
                raise ResultTooLarge
            values.append(materialized)
        response = result(
            "ok",
            columns=columns,
            rows=values,
            row_count=len(values),
            truncated=truncated,
            driver=driver,
            target=target.summary(),
        )
        if (
            len(json.dumps(response, ensure_ascii=False).encode("utf-8"))
            > MAX_RESULT_BYTES
        ):
            raise ResultTooLarge
        return response
    except ResultTooLarge:
        return result("result_too_large")
    except Exception:
        return result("query_failed")
    finally:
        try:
            connection.close()
        except Exception:
            pass


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    try:
        output = execute(payload)
    except Exception:
        output = result("internal_error")
    sys.stdout.write(
        json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    )
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
