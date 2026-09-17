#!/usr/bin/env python3
"""Offline tests for the governed Fabric pyodbc fallback."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import struct
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))
spec = importlib.util.spec_from_file_location(
    "fabric_sql_query", ROOT / "lib" / "fabric_sql_query.py"
)
fsq = importlib.util.module_from_spec(spec)
sys.modules["fabric_sql_query"] = fsq
spec.loader.exec_module(fsq)

WORKSPACE = "22222222-2222-4222-8222-222222222222"
ITEM = "33333333-3333-4333-8333-333333333333"
LAKEHOUSE = "44444444-4444-4444-8444-444444444444"
TENANT = "11111111-1111-4111-8111-111111111111"
PRINCIPAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SERVER = "fixture.datawarehouse.fabric.microsoft.com"
QUERY = "SELECT TOP (2) customer_id FROM dbo.Customer"


def jwt(audience: str) -> str:
    def enc(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{enc({'alg': 'none'})}.{enc({'tid': TENANT, 'oid': PRINCIPAL, 'aud': audience})}.sig"


FABRIC_TOKEN = jwt("fabric")
SQL_TOKEN = jwt("sql")


def fixture(
    item_type: str = "Warehouse",
) -> tuple[tempfile.TemporaryDirectory, Path, Path]:
    temp = tempfile.TemporaryDirectory()
    root = Path(temp.name)
    project = root / "project"
    (project / ".coop").mkdir(parents=True)
    item_id = ITEM if item_type == "Warehouse" else LAKEHOUSE
    endpoint_properties = (
        ""
        if item_type == "Warehouse"
        else f'    sqlEndpointProperties:\n      id: "{ITEM}"\n'
    )
    (project / ".coop" / "project.yml").write_text(
        f"""fabric:
  default_workspace_id: "{WORKSPACE}"
  default_sql_endpoint:
    item_type: "{item_type}"
    item_name: "CustomerWarehouse"
    item_id: "{item_id}"
{endpoint_properties}
""",
        encoding="utf-8",
    )
    agent = root / "agent"
    agent.mkdir()
    (agent / "mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "fabric-sqlendpoint": {
                        "url": f"{fsq.wmcp.FABRIC_RESOURCE}/v1/mcp/dataPlane/workspaces/{WORKSPACE}/items/{ITEM}/sqlEndpoint",
                        "auth": "bearer",
                        "bearerTokenEnv": fsq.wmcp.FABRIC_TOKEN_ENV,
                        "lifecycle": "lazy",
                        "_coop_target": {"item_name": "CustomerWarehouse"},
                    }
                },
                "_coop": {"managed_servers": ["fabric-sqlendpoint"]},
            }
        ),
        encoding="utf-8",
    )
    return temp, project, agent


class FakeCursor:
    def __init__(self, rows=None, description=None):
        self.timeout = None
        self.query = None
        self.rows = [(1, b"a"), (2, b"b"), (3, b"c")] if rows is None else rows
        self.description = description or [("customer_id",), ("seen_at",)]
        self.fetch_index = 0

    def execute(self, query):
        self.query = query

    def fetchone(self):
        if self.fetch_index >= len(self.rows):
            return None
        row = self.rows[self.fetch_index]
        self.fetch_index += 1
        return row


class FakeConnection:
    def __init__(self, rows=None, description=None):
        self.cursor_value = FakeCursor(rows, description)
        self.closed = False

    def cursor(self):
        return self.cursor_value

    def close(self):
        self.closed = True


class FakePyodbc:
    def __init__(self, drivers=None, connect_error=None, rows=None, description=None):
        self.driver_values = drivers or [
            "ODBC Driver 17 for SQL Server",
            "ODBC Driver 18 for SQL Server",
            "ODBC Driver 19 for SQL Server",
        ]
        self.connect_error = connect_error
        self.connection = FakeConnection(rows, description)
        self.call = None

    def drivers(self):
        return self.driver_values

    def connect(self, connection_string, **kwargs):
        self.call = (connection_string, kwargs)
        if self.connect_error:
            raise self.connect_error
        return self.connection


# Reject anything except one literal-TOP SELECT before target/auth/connect work.
for rejected in (
    "DELETE FROM dbo.Customer",
    "SELECT * FROM dbo.Customer",
    "SELECT TOP (2) * FROM dbo.Customer; SELECT TOP (1) * FROM dbo.Secret",
    "SELECT TOP (2) * FROM OtherDb.dbo.Secret",
    "WITH x AS (SELECT TOP (2) * FROM dbo.Customer) SELECT TOP (2) * FROM x",
    "SELECT TOP (1001) * FROM dbo.Customer",
):
    with mock.patch.object(fsq, "_canonical_target") as target:
        assert fsq.execute({"query": rejected})["state"] == "query_rejected"
        target.assert_not_called()
assert fsq.execute({"query": QUERY, "target": ITEM})["state"] == "input_invalid"
assert fsq.execute({"query": QUERY, "maximum_rows": 0})["state"] == "query_rejected"

# Access-token packing is SQL Server's little-endian length + UTF-16-LE bytes.
packed = fsq.pack_access_token("abc")
assert packed == struct.pack("<I", 6) + "abc".encode("utf-16-le")
assert struct.unpack("<I", packed[:4])[0] == len(packed[4:])

# Canonical project target, Driver 18+ selection, REST discovery, identity binding,
# query timeout, row cap, and structured output all run without network.
temp, project, agent = fixture()
resources = []
rest_calls = []
pyodbc = FakePyodbc()


def fake_token(*, timeout=8, resource=fsq.wmcp.FABRIC_RESOURCE):
    resources.append(resource)
    return (FABRIC_TOKEN if resource == fsq.wmcp.FABRIC_RESOURCE else SQL_TOKEN, "ok")


def fake_rest(url, token, timeout=8):
    rest_calls.append((url, token, timeout))
    return {
        "id": ITEM,
        "type": "Warehouse",
        "workspaceId": WORKSPACE,
        "properties": {"connectionString": SERVER},
    }, "ok"


with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": pyodbc}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
    mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
):
    output = fsq.execute({"query": QUERY, "maximum_rows": 1}, cwd=project)

assert output == {
    "ok": True,
    "state": "ok",
    "columns": ["customer_id", "seen_at"],
    "rows": [[1, "61"]],
    "row_count": 1,
    "truncated": True,
    "driver": "ODBC Driver 19 for SQL Server",
}
assert resources == [fsq.wmcp.FABRIC_RESOURCE, fsq.SQL_RESOURCE]
assert rest_calls == [
    (
        f"{fsq.wmcp.FABRIC_RESOURCE}/v1/workspaces/{WORKSPACE}/warehouses/{ITEM}",
        FABRIC_TOKEN,
        8,
    )
]
connection_string, kwargs = pyodbc.call
assert "ODBC Driver 19 for SQL Server" in connection_string
assert SERVER in connection_string and "CustomerWarehouse" in connection_string
assert (
    "Encrypt=yes" in connection_string
    and "TrustServerCertificate=no" in connection_string
)
assert "UID=" not in connection_string and "PWD=" not in connection_string
assert kwargs["attrs_before"] == {
    fsq.SQL_COPT_SS_ACCESS_TOKEN: fsq.pack_access_token(SQL_TOKEN)
}
assert kwargs["timeout"] == fsq.CONNECT_TIMEOUT and kwargs["autocommit"] is True
assert pyodbc.connection.cursor_value.timeout == fsq.QUERY_TIMEOUT
assert pyodbc.connection.cursor_value.query == QUERY
assert pyodbc.connection.closed is True

# Lakehouse discovery uses the source Lakehouse ID and the documented nested
# sqlEndpointProperties response while preserving the configured endpoint ID.
lake_temp, lake_project, lake_agent = fixture("Lakehouse")
lake_calls = []


def fake_lake_rest(url, token, timeout=8):
    lake_calls.append((url, token, timeout))
    return {
        "id": LAKEHOUSE,
        "type": "Lakehouse",
        "workspaceId": WORKSPACE,
        "properties": {
            "sqlEndpointProperties": {"id": ITEM, "connectionString": SERVER}
        },
    }, "ok"


with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(lake_agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc()}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
    mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_lake_rest),
):
    assert fsq.execute({"query": QUERY}, cwd=lake_project)["state"] == "ok"
assert lake_calls[0][0] == (
    f"{fsq.wmcp.FABRIC_RESOURCE}/v1/workspaces/{WORKSPACE}/lakehouses/{LAKEHOUSE}"
)

# Missing or mismatched documented identity fields fail closed.
lake_target = fsq.wmcp.project_target(
    fsq.wmcp.load_project(lake_project / ".coop" / "project.yml")
)
for invalid_item in (
    {"properties": {"sqlEndpointProperties": {"id": ITEM, "connectionString": SERVER}}},
    {
        "id": LAKEHOUSE,
        "type": "Lakehouse",
        "workspaceId": "33333333-3333-4333-8333-333333333333",
        "properties": {
            "sqlEndpointProperties": {"id": ITEM, "connectionString": SERVER}
        },
    },
    {
        "id": LAKEHOUSE,
        "type": "Lakehouse",
        "workspaceId": WORKSPACE,
        "properties": {"sqlEndpointProperties": {"connectionString": SERVER}},
    },
):
    with mock.patch.object(
        fsq.wmcp, "fabric_get_json", return_value=(invalid_item, "ok")
    ):
        assert fsq._discover_server(lake_target, FABRIC_TOKEN)[1] == "endpoint_invalid"

# One oversized cell and aggregate overflow return one stable, non-sensitive state.
for rows in (
    [("x" * (fsq.MAX_CELL_CHARS + 1), "small")],
    [("x" * fsq.MAX_CELL_CHARS, "small") for _ in range(16)],
):
    sized_pyodbc = FakePyodbc(rows=rows)
    with (
        mock.patch.dict(
            os.environ,
            {
                "PI_CODING_AGENT_DIR": str(agent),
                fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
            },
            clear=False,
        ),
        mock.patch.dict(sys.modules, {"pyodbc": sized_pyodbc}),
        mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
        mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
    ):
        sized = fsq.execute(
            {"query": "SELECT TOP (20) customer_id FROM dbo.Customer"}, cwd=project
        )
    assert sized == {"ok": False, "state": "result_too_large"}

# Fetch incrementally and reject oversized columns even when no rows are returned.
wide_columns = [("x" * fsq.MAX_COLUMN_CHARS,) for _ in range(2_000)]
sized_pyodbc = FakePyodbc(rows=[], description=wide_columns)
with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": sized_pyodbc}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
    mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
):
    sized = fsq.execute({"query": QUERY}, cwd=project)
assert sized == {"ok": False, "state": "result_too_large"}
assert sized_pyodbc.connection.cursor_value.fetch_index == 0

# Missing prerequisites and canonical-target drift return stable diagnostics.
with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": None}),
):
    missing = fsq.execute({"query": QUERY}, cwd=project)
assert missing["state"] == "pyodbc_unavailable"
assert missing == {"ok": False, "state": "pyodbc_unavailable", "stage": "driver_import"}

old = json.loads((agent / "mcp.json").read_text(encoding="utf-8"))
old["mcpServers"]["fabric-sqlendpoint"]["_coop_target"]["item_name"] = "OtherWarehouse"
(agent / "mcp.json").write_text(json.dumps(old), encoding="utf-8")
with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(agent)}, clear=False):
    assert fsq.execute({"query": QUERY}, cwd=project)["state"] == "target_mismatch"

# Driver and connection failures never include token, SQL, server, or exception text.
_, project2, agent2 = fixture()
for fake, expected in (
    (FakePyodbc(drivers=["ODBC Driver 17 for SQL Server"]), "odbc_driver_unavailable"),
    (
        FakePyodbc(connect_error=RuntimeError(f"{SQL_TOKEN} {QUERY} {SERVER}")),
        "connection_failed",
    ),
):
    with (
        mock.patch.dict(
            os.environ,
            {
                "PI_CODING_AGENT_DIR": str(agent2),
                fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
            },
            clear=False,
        ),
        mock.patch.dict(sys.modules, {"pyodbc": fake}),
        mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
        mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
    ):
        diagnostic = fsq.execute({"query": QUERY}, cwd=project2)
    blob = json.dumps(diagnostic)
    assert diagnostic["state"] == expected
    assert SQL_TOKEN not in blob and QUERY not in blob and SERVER not in blob

# Azure/REST failures retain only stable state + stage; no client switching.
with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent2),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc()}),
    mock.patch.object(fsq.wmcp, "az_access_token", return_value=("", "auth_required")),
):
    assert fsq.execute({"query": QUERY}, cwd=project2) == {
        "ok": False,
        "state": "auth_required",
        "stage": "fabric_rest_token",
    }

temp.cleanup()
lake_temp.cleanup()
print("fabric-sql-query tests passed")
