#!/usr/bin/env python3
"""Governed stdin/stdout pyodbc fallback for one bounded Fabric SQL read."""

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

import warehouse_mcp as wmcp

SQL_RESOURCE = "https://database.windows.net/"
SQL_COPT_SS_ACCESS_TOKEN = 1256
MAX_ROWS = 1000
CONNECT_TIMEOUT = 15
QUERY_TIMEOUT = 45
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
            (Path(agent_dir) / "mcp.json").read_text(encoding="utf-8-sig")
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


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


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
    target, database, state = _canonical_target(project_path)
    if state != "ok" or target is None:
        return result(state)
    try:
        import pyodbc  # type: ignore[import-not-found]
    except (ImportError, OSError):
        return result(
            "pyodbc_unavailable",
            python={"executable": sys.executable, "version": sys.version.split()[0]},
        )
    driver = select_driver(list(pyodbc.drivers()))
    if not driver:
        return result("odbc_driver_unavailable", minimum_version=18)
    fabric_token, state = wmcp.az_access_token(resource=wmcp.FABRIC_RESOURCE)
    if state != "ok":
        return result(state, stage="fabric_rest_token")
    endpoint_url = (
        f"{wmcp.FABRIC_RESOURCE}/v1/workspaces/{target.workspace_id}/"
        f"sqlEndpoints/{target.item_id}/connectionString"
    )
    endpoint, state = wmcp.fabric_get_json(endpoint_url, fabric_token)
    server = endpoint.get("connectionString", "") if state == "ok" else ""
    if state != "ok":
        return result(state, stage="endpoint_discovery")
    if not isinstance(server, str) or not SAFE_SERVER.fullmatch(server):
        return result("endpoint_invalid")
    sql_token, state = wmcp.az_access_token(resource=SQL_RESOURCE)
    if state != "ok":
        return result(state, stage="database_token")
    launch_identity = _jwt_identity(os.environ.get(wmcp.FABRIC_TOKEN_ENV, ""))
    if (
        not launch_identity
        or _jwt_identity(fabric_token) != launch_identity
        or _jwt_identity(sql_token) != launch_identity
    ):
        return result("identity_mismatch")
    connection_string = (
        f"DRIVER={{{driver}}};SERVER={server},1433;DATABASE={{{database.replace('}', '}}')}}};"
        "Encrypt=yes;TrustServerCertificate=no;"
    )
    try:
        connection = pyodbc.connect(
            connection_string,
            attrs_before={SQL_COPT_SS_ACCESS_TOKEN: pack_access_token(sql_token)},
            timeout=CONNECT_TIMEOUT,
            autocommit=True,
        )
    except Exception:
        return result("connection_failed")
    try:
        cursor = connection.cursor()
        cursor.timeout = QUERY_TIMEOUT
        cursor.execute(query)
        columns = [str(item[0]) for item in (cursor.description or [])]
        rows = cursor.fetchmany(row_limit + 1)
        truncated = len(rows) > row_limit
        values = [[_json_value(value) for value in row] for row in rows[:row_limit]]
        return result(
            "ok",
            columns=columns,
            rows=values,
            row_count=len(values),
            truncated=truncated,
            driver=driver,
        )
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
